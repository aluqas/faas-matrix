// Room Join Workflow - Durable execution for reliable room joins
//
// This workflow handles room joins with:
// - Automatic retry on failures
// - Federation handshake (make_join → send_join) with backoff
// - Batched member notifications
// - Step persistence for resume on failure

import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { Env, PDU } from "../types";
import { generateEventId } from "../utils/ids";
import { federationGet, federationPut } from "../services/federation-keys";
import {
  storeEvent,
  getRoomMembers,
  getStateEvent,
  getRoomEvents,
  getMembership,
  getServersInRoomsWithUser,
  getUserDevices,
} from "../services/database";
import {
  applyMembershipTransitionToDatabase,
  loadMembershipTransitionContext,
} from "../matrix/application/membership-transition-service";
import { persistFederationStateSnapshot } from "../matrix/application/federation-handler-service";
import {
  type JsonObject,
  type RemoteJoinTemplate,
  type RemoteSendJoinResponse,
  type RoomJoinWorkflowParams,
  type RoomJoinWorkflowResult,
  toRemoteJoinTemplate,
  toRemoteSendJoinResponse,
} from "../types/workflows";
import { runWorkflowEffect } from "../matrix/application/effect-runtime";
import { withLogContext } from "../matrix/application/logging";
import { parseDeviceKeysPayload } from "../api/keys-contracts";
import { publishDeviceListUpdatesForNewlySharedServers } from "../matrix/application/features/device-lists/command";
import { queueFederationEdu } from "../matrix/application/features/shared/federation-edu-queue";

export type JoinParams = RoomJoinWorkflowParams;
export type JoinResult = RoomJoinWorkflowResult;
type JoinWorkflowUnsigned = {
  prev_content: JsonObject;
  prev_sender?: string;
};
type JoinWorkflowEvent = Omit<PDU, "content" | "unsigned"> & {
  content: JsonObject;
  unsigned?: JoinWorkflowUnsigned;
};

function withDefined<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  if (value === undefined) {
    return {};
  }

  return { [key]: value } as { [P in K]?: V };
}

function parseWorkflowJson<T>(payload: string): T {
  return JSON.parse(payload) as T;
}

async function getStoredDeviceKeysFromKv(kv: KVNamespace, userId: string, deviceId: string) {
  return parseDeviceKeysPayload(await kv.get(`device:${userId}:${deviceId}`, "json"));
}

export class RoomJoinWorkflow extends WorkflowEntrypoint<Env, JoinParams> {
  async run(event: WorkflowEvent<JoinParams>, step: WorkflowStep): Promise<JoinResult> {
    const {
      roomId,
      userId,
      isRemote,
      remoteServer,
      remoteServers,
      displayName,
      avatarUrl,
      reason,
    } = event.payload;
    const preJoinSharedServers = await getServersInRoomsWithUser(this.env.DB, userId);
    const logger = withLogContext({
      component: "room-join-workflow",
      operation: "join",
      room_id: roomId,
      user_id: userId,
      destination: remoteServer,
      debugEnabled: true,
    });
    await runWorkflowEffect(
      logger.info("room_join.workflow.start", {
        is_remote: isRemote,
        candidate_count: remoteServers?.length ?? (remoteServer ? 1 : 0),
      }),
    );

    try {
      // Step 1: For remote joins, get join template from remote server
      // Try each candidate server in order until one succeeds
      let remoteEventTemplate: RemoteJoinTemplate | null = null;
      let successfulRemoteServer: string | undefined = remoteServer;
      if (isRemote && (remoteServer || remoteServers?.length)) {
        const candidates = remoteServers?.length
          ? remoteServers
          : remoteServer
            ? [remoteServer]
            : [];
        remoteEventTemplate = (await step.do(
          "make-join",
          {
            retries: {
              limit: 3,
              delay: 5000,
              backoff: "exponential",
            },
            timeout: 30000,
          },
          async () => {
            let lastError: Error | undefined;
            for (const candidate of candidates) {
              try {
                const result = await this.makeJoinRequest(candidate, roomId, userId);
                successfulRemoteServer = candidate;
                return result;
              } catch (err) {
                lastError = err instanceof Error ? err : new Error(String(err));
                await runWorkflowEffect(
                  logger.warn("room_join.workflow.make_join_retry", {
                    destination: candidate,
                    error_message: lastError.message,
                  }),
                );
              }
            }
            throw lastError ?? new Error("All remote servers failed for make_join");
          },
        )) as RemoteJoinTemplate | null;
      }

      // Step 2: Create and sign the join event
      const joinEventData = parseWorkflowJson<JoinWorkflowEvent>(
        await step.do("create-event", async () => {
          return JSON.stringify(
            await this.createJoinEvent({
              roomId,
              userId,
              ...withDefined("displayName", displayName),
              ...withDefined("avatarUrl", avatarUrl),
              ...withDefined("reason", reason),
              ...withDefined("remoteEventTemplate", remoteEventTemplate),
            }),
          );
        }),
      );

      // Step 3: For remote joins, send signed event to remote server and process room state
      if (isRemote && successfulRemoteServer && joinEventData) {
        const sendJoinResponse = parseWorkflowJson<RemoteSendJoinResponse>(
          await step.do(
            "send-join",
            {
              retries: {
                limit: 3,
                delay: 5000,
                backoff: "exponential",
              },
              timeout: 30000,
            },
            async () => {
              return JSON.stringify(
                await this.sendJoinRequest(successfulRemoteServer!, roomId, joinEventData),
              );
            },
          ),
        );

        // Process the room state received from the remote server
        await step.do("process-remote-state", async () => {
          const roomVersion = remoteEventTemplate?.room_version || "10";
          await persistFederationStateSnapshot(this.env.DB, {
            roomId,
            roomVersion,
            stateEvents: sendJoinResponse.state,
            authChain: sendJoinResponse.auth_chain,
            source: "workflow",
          });
        });
      }

      // Step 4: Persist event and membership locally
      await step.do("persist", async () => {
        const transitionContext = await loadMembershipTransitionContext(
          this.env.DB,
          roomId,
          userId,
        );
        await storeEvent(this.env.DB, joinEventData);
        await applyMembershipTransitionToDatabase(this.env.DB, {
          roomId,
          event: joinEventData,
          source: "workflow",
          context: transitionContext,
        });
      });

      await step.do("publish-device-lists", async () => {
        try {
          const published = await publishDeviceListUpdatesForNewlySharedServers(
            {
              userId,
              previouslySharedServers: preJoinSharedServers,
            },
            {
              localServerName: this.env.SERVER_NAME,
              now: () => Date.now(),
              getSharedRemoteServers: (sharedUserId) =>
                getServersInRoomsWithUser(this.env.DB, sharedUserId),
              getUserDevices: (deviceUserId) => getUserDevices(this.env.DB, deviceUserId),
              getStoredDeviceKeys: (deviceUserId, deviceId) =>
                getStoredDeviceKeysFromKv(this.env.DEVICE_KEYS, deviceUserId, deviceId),
              queueEdu: (destination, eduType, content) =>
                queueFederationEdu(this.env, destination, eduType, content),
            },
          );

          if (published.sentCount > 0) {
            await runWorkflowEffect(
              logger.info("room_join.workflow.device_list_shared", {
                destination_count: published.destinations.length,
                device_count: published.deviceCount,
                sent_count: published.sentCount,
              }),
            );
          }
        } catch (error) {
          await runWorkflowEffect(
            logger.error("room_join.workflow.device_list_share_error", error),
          );
        }
      });

      // Step 5: Get room members for notification
      const members = (await step.do("get-members", async () => {
        const memberList = await getRoomMembers(this.env.DB, roomId);
        // Exclude the joining user from notifications
        return memberList.filter((m) => m.userId !== userId).map((m) => ({ userId: m.userId }));
      })) as Array<{ userId: string }>;

      // Step 6: Notify members in batches of 50
      const BATCH_SIZE = 50;
      for (let i = 0; i < members.length; i += BATCH_SIZE) {
        const batch = members.slice(i, i + BATCH_SIZE);
        await step.do(`notify-batch-${i}`, async () => {
          await this.notifyMemberBatch(batch, joinEventData);
        });
      }

      await runWorkflowEffect(
        logger.info("room_join.workflow.success", {
          event_id: joinEventData.event_id,
        }),
      );

      return {
        eventId: joinEventData.event_id,
        roomId,
        success: true,
      };
    } catch (error) {
      await runWorkflowEffect(logger.error("room_join.workflow.error", error));
      return {
        eventId: "",
        roomId,
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  // Make a make_join request to a remote server
  private async makeJoinRequest(
    remoteServer: string,
    roomId: string,
    userId: string,
  ): Promise<RemoteJoinTemplate> {
    const logger = withLogContext({
      component: "room-join-workflow",
      operation: "make_join",
      room_id: roomId,
      user_id: userId,
      destination: remoteServer,
      debugEnabled: true,
    });
    await runWorkflowEffect(logger.info("room_join.workflow.make_join_start"));

    const response = await federationGet(
      remoteServer,
      `/_matrix/federation/v1/make_join/${encodeURIComponent(roomId)}/${encodeURIComponent(userId)}`,
      this.env.SERVER_NAME,
      this.env.DB,
      this.env.CACHE,
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`make_join failed: ${response.status} ${error}`);
    }

    const result = toRemoteJoinTemplate((await response.json()) as unknown);
    if (!result) {
      throw new Error("make_join returned invalid response");
    }
    return result;
  }

  // Create a join event (either from remote template or local state)
  private async createJoinEvent(params: {
    roomId: string;
    userId: string;
    displayName?: string;
    avatarUrl?: string;
    reason?: string;
    remoteEventTemplate?: RemoteJoinTemplate | null;
  }): Promise<JoinWorkflowEvent> {
    const { roomId, userId, displayName, avatarUrl, reason, remoteEventTemplate } = params;

    let authEvents: string[] = [];
    let prevEvents: string[] = [];
    let depth = 1;
    let prevContent: JsonObject | undefined;
    let prevSender: string | undefined;

    const currentMembershipEvent = await getStateEvent(
      this.env.DB,
      roomId,
      "m.room.member",
      userId,
    );
    const currentMembershipContent = currentMembershipEvent?.content as
      | { membership?: unknown }
      | undefined;
    if (currentMembershipContent?.membership !== undefined) {
      prevContent = currentMembershipEvent?.content as JsonObject;
      prevSender = currentMembershipEvent?.sender;
    }

    if (remoteEventTemplate?.event) {
      // Use template from remote server
      authEvents = remoteEventTemplate.event.auth_events || [];
      prevEvents = remoteEventTemplate.event.prev_events || [];
      depth = remoteEventTemplate.event.depth || 1;
    } else {
      // Get local room state
      const createEvent = await getStateEvent(this.env.DB, roomId, "m.room.create");
      const joinRulesEvent = await getStateEvent(this.env.DB, roomId, "m.room.join_rules");
      const powerLevelsEvent = await getStateEvent(this.env.DB, roomId, "m.room.power_levels");
      const currentMembership = await getMembership(this.env.DB, roomId, userId);

      if (createEvent) authEvents.push(createEvent.event_id);
      if (joinRulesEvent) authEvents.push(joinRulesEvent.event_id);
      if (powerLevelsEvent) authEvents.push(powerLevelsEvent.event_id);
      if (currentMembership) authEvents.push(currentMembership.eventId);

      const { events: latestEvents } = await getRoomEvents(this.env.DB, roomId, undefined, 1);
      prevEvents = latestEvents.map((e) => e.event_id);
      depth = (latestEvents[0]?.depth ?? 0) + 1;
    }

    const eventId = await generateEventId(this.env.SERVER_NAME, remoteEventTemplate?.room_version);

    const memberContent: JsonObject = {
      membership: "join",
    };

    if (displayName) {
      memberContent["displayname"] = displayName;
    }
    if (avatarUrl) {
      memberContent["avatar_url"] = avatarUrl;
    }
    if (reason) {
      memberContent["reason"] = reason;
    }

    const event: JoinWorkflowEvent = {
      event_id: eventId,
      room_id: roomId,
      sender: userId,
      type: "m.room.member",
      state_key: userId,
      content: memberContent,
      origin_server_ts: Date.now(),
      depth,
      auth_events: authEvents,
      prev_events: prevEvents,
      ...withDefined(
        "unsigned",
        prevContent
          ? {
              prev_content: prevContent,
              ...withDefined("prev_sender", prevSender),
            }
          : undefined,
      ),
    };

    return event;
  }

  // Send a send_join request to a remote server
  private async sendJoinRequest(
    remoteServer: string,
    roomId: string,
    joinEvent: JoinWorkflowEvent,
  ): Promise<RemoteSendJoinResponse> {
    const logger = withLogContext({
      component: "room-join-workflow",
      operation: "send_join",
      room_id: roomId,
      event_id: joinEvent.event_id,
      destination: remoteServer,
      debugEnabled: true,
    });
    await runWorkflowEffect(logger.info("room_join.workflow.send_join_start"));

    // Try v2 first (Matrix v1.1+), fall back to v1 if server returns 400/404
    let response = await federationPut(
      remoteServer,
      `/_matrix/federation/v2/send_join/${encodeURIComponent(roomId)}/${encodeURIComponent(joinEvent.event_id)}`,
      joinEvent,
      this.env.SERVER_NAME,
      this.env.DB,
      this.env.CACHE,
    );

    if (response.status === 400 || response.status === 404) {
      await runWorkflowEffect(
        logger.warn("room_join.workflow.send_join_fallback", {
          status: response.status,
        }),
      );
      response = await federationPut(
        remoteServer,
        `/_matrix/federation/v1/send_join/${encodeURIComponent(roomId)}/${encodeURIComponent(joinEvent.event_id)}`,
        joinEvent,
        this.env.SERVER_NAME,
        this.env.DB,
        this.env.CACHE,
      );
    }

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`send_join failed: ${response.status} ${error}`);
    }

    return toRemoteSendJoinResponse((await response.json()) as unknown);
  }

  // Notify a batch of members about the join
  private async notifyMemberBatch(
    members: Array<{ userId: string }>,
    joinEvent: JoinWorkflowEvent,
  ): Promise<void> {
    const logger = withLogContext({
      component: "room-join-workflow",
      operation: "notify_members",
      room_id: joinEvent.room_id,
      event_id: joinEvent.event_id,
      debugEnabled: true,
    });
    const promises = members.map(async (member) => {
      try {
        const syncDO = this.env.SYNC;
        const doId = syncDO.idFromName(member.userId);
        const stub = syncDO.get(doId);

        await stub.fetch(
          new Request("http://internal/notify", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              roomId: joinEvent.room_id,
              eventId: joinEvent.event_id,
              eventType: joinEvent.type,
            }),
          }),
        );
      } catch (error) {
        await runWorkflowEffect(
          logger.error("room_join.workflow.notify_member_error", error, {
            user_id: member.userId,
          }),
        );
        // Don't throw - continue notifying other members
      }
    });

    await Promise.all(promises);
  }
}
