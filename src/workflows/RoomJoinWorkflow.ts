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
import { calculateContentHash, calculateReferenceHashEventId } from "../utils/crypto";
import { federationGet, federationPut } from "../services/federation-keys";
import { getRoomVersion } from "../services/room-versions";
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
  type RoomJoinWorkflowResult,
  type RemoteJoinTemplate,
  type RemoteSendJoinResponse,
  type RoomJoinWorkflowParams,
  toRemoteJoinTemplate,
  toRemoteSendJoinResponse,
} from "../types/workflows";
import { runWorkflowEffect } from "../matrix/application/effect-runtime";
import { withLogContext } from "../matrix/application/logging";
import { parseDeviceKeysPayload } from "../api/keys-contracts";
import { publishDeviceListUpdatesForNewlySharedServers } from "../matrix/application/features/device-lists/command";
import { queueFederationEdu } from "../matrix/application/features/shared/federation-edu-queue";
import {
  clearPartialStateJoin,
  markPartialStateJoinCompleted,
  markPartialStateJoin,
} from "../matrix/application/features/partial-state/tracker";
import {
  clearPartialStateJoinMetadata,
  getSharedServersInRoomsWithUserIncludingPartialState,
  upsertPartialStateJoinMetadata,
} from "../matrix/application/features/partial-state/shared-servers";

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

type RemoteStateIdsResponse = {
  pdu_ids: string[];
  auth_chain_ids: string[];
};

type RemoteStateResponse = {
  pdus: unknown[];
  auth_chain: unknown[];
};

type RemoteJoinStepSuccess<T> = {
  success: true;
  value: T;
};

type RemoteJoinStepFailure = {
  success: false;
  failure: Pick<RoomJoinWorkflowResult, "error" | "errorStatus" | "errorErrcode">;
};

type RemoteJoinHttpErrorOptions = {
  operation: "make_join" | "send_join";
  destination: string;
  status: number;
  message: string;
  errcode?: RoomJoinWorkflowResult["errorErrcode"];
};

class RemoteJoinHttpError extends Error {
  readonly operation: "make_join" | "send_join";
  readonly destination: string;
  readonly status: number;
  readonly errcode?: RoomJoinWorkflowResult["errorErrcode"];
  readonly retryable: boolean;

  constructor(options: RemoteJoinHttpErrorOptions) {
    super(options.message);
    this.name = "RemoteJoinHttpError";
    this.operation = options.operation;
    this.destination = options.destination;
    this.status = options.status;
    this.errcode = options.errcode;
    this.retryable = options.status === 429 || options.status >= 500;
  }
}

function parseMatrixErrorPayload(value: string): {
  errcode?: RoomJoinWorkflowResult["errorErrcode"];
  error?: string;
} {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const parsedRecord = parsed as Record<string, unknown>;
    const errcode =
      typeof parsedRecord["errcode"] === "string"
        ? (parsedRecord["errcode"] as RoomJoinWorkflowResult["errorErrcode"])
        : undefined;
    const error = typeof parsedRecord["error"] === "string" ? parsedRecord["error"] : undefined;
    return { ...withDefined("errcode", errcode), ...withDefined("error", error) };
  } catch {
    return {};
  }
}

function toWorkflowFailure(
  error: RemoteJoinHttpError,
): Pick<RoomJoinWorkflowResult, "error" | "errorStatus" | "errorErrcode"> {
  const payload = parseMatrixErrorPayload(error.message);
  return {
    error: payload.error ?? error.message,
    errorStatus: error.status,
    ...withDefined("errorErrcode", payload.errcode ?? error.errcode),
  };
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
        const makeJoinResult = (await step.do(
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
            let lastNonRetryableError: RemoteJoinHttpError | undefined;
            for (const candidate of candidates) {
              try {
                const result = await this.makeJoinRequest(candidate, roomId, userId);
                return {
                  success: true,
                  value: {
                    remoteEventTemplate: result,
                    remoteServer: candidate,
                  },
                } satisfies RemoteJoinStepSuccess<{
                  remoteEventTemplate: RemoteJoinTemplate;
                  remoteServer: string;
                }>;
              } catch (err) {
                if (err instanceof RemoteJoinHttpError && !err.retryable) {
                  lastNonRetryableError = err;
                  await runWorkflowEffect(
                    logger.warn("room_join.workflow.make_join_terminal_error", {
                      destination: candidate,
                      error_message: err.message,
                      status: err.status,
                      errcode: err.errcode,
                    }),
                  );
                  continue;
                }

                lastError = err instanceof Error ? err : new Error(String(err));
                await runWorkflowEffect(
                  logger.warn("room_join.workflow.make_join_retry", {
                    destination: candidate,
                    error_message: lastError.message,
                  }),
                );
              }
            }

            if (!lastError && lastNonRetryableError) {
              return {
                success: false,
                failure: toWorkflowFailure(lastNonRetryableError),
              } satisfies RemoteJoinStepFailure;
            }

            throw lastError ?? new Error("All remote servers failed for make_join");
          },
        )) as
          | RemoteJoinStepSuccess<{
              remoteEventTemplate: RemoteJoinTemplate;
              remoteServer: string;
            }>
          | RemoteJoinStepFailure;

        if (!makeJoinResult.success) {
          return {
            eventId: "",
            roomId,
            success: false,
            ...makeJoinResult.failure,
          };
        }

        remoteEventTemplate = makeJoinResult.value.remoteEventTemplate;
        successfulRemoteServer = makeJoinResult.value.remoteServer;
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
      let partialStateEventId: string | undefined;
      let remoteSendJoinResponse: RemoteSendJoinResponse | undefined;
      if (isRemote && successfulRemoteServer && joinEventData) {
        const sendJoinResult = parseWorkflowJson<
          RemoteJoinStepSuccess<RemoteSendJoinResponse> | RemoteJoinStepFailure
        >(
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
              try {
                return JSON.stringify({
                  success: true,
                  value: await this.sendJoinRequest(successfulRemoteServer!, roomId, joinEventData),
                } satisfies RemoteJoinStepSuccess<RemoteSendJoinResponse>);
              } catch (error) {
                if (error instanceof RemoteJoinHttpError && !error.retryable) {
                  return JSON.stringify({
                    success: false,
                    failure: toWorkflowFailure(error),
                  } satisfies RemoteJoinStepFailure);
                }
                throw error;
              }
            },
          ),
        );

        if (!sendJoinResult.success) {
          return {
            eventId: "",
            roomId,
            success: false,
            ...sendJoinResult.failure,
          };
        }
        const sendJoinResponse = sendJoinResult.value;
        remoteSendJoinResponse = sendJoinResponse;

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

        if (sendJoinResponse.members_omitted === true) {
          partialStateEventId = joinEventData.prev_events[0];
          if (!partialStateEventId) {
            throw new Error("partial send_join response missing prev_event boundary");
          }

          await step.do("mark-partial-state", async () => {
            const marker = {
              roomId,
              userId,
              eventId: partialStateEventId!,
              startedAt: Date.now(),
              ...withDefined("remoteServer", successfulRemoteServer),
              ...withDefined("serversInRoom", sendJoinResponse.servers_in_room),
            };
            await upsertPartialStateJoinMetadata(this.env.DB, marker);
            await markPartialStateJoin(this.env.CACHE, marker);
          });
        }
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

      if (isRemote && successfulRemoteServer && partialStateEventId) {
        await step.do(
          "resync-partial-state",
          {
            retries: {
              limit: 3,
              delay: 500,
              backoff: "exponential",
            },
            timeout: 120000,
          },
          async () => {
            const roomVersion = remoteEventTemplate?.room_version || "10";
            await this.fetchAndPersistPartialState(
              successfulRemoteServer!,
              roomId,
              partialStateEventId!,
              roomVersion,
            );
            await markPartialStateJoinCompleted(this.env.CACHE, {
              roomId,
              userId,
              eventId: partialStateEventId!,
              startedAt: Date.now(),
              ...withDefined("remoteServer", successfulRemoteServer),
              ...withDefined("serversInRoom", remoteSendJoinResponse?.servers_in_room),
            });
            await clearPartialStateJoin(this.env.CACHE, userId, roomId);
            await clearPartialStateJoinMetadata(this.env.DB, userId, roomId);
            await this.notifyMemberBatch([{ userId }], joinEventData);
          },
        );
      }

      await step.do("publish-device-lists", async () => {
        try {
          const roomEncryptionEvent = await getStateEvent(
            this.env.DB,
            roomId,
            "m.room.encryption",
            "",
          );
          if (!roomEncryptionEvent) {
            await runWorkflowEffect(
              logger.info("room_join.workflow.device_list_share_skipped", {
                reason: "room_not_encrypted",
              }),
            );
            return;
          }

          const published = await publishDeviceListUpdatesForNewlySharedServers(
            {
              userId,
              previouslySharedServers: preJoinSharedServers,
              sharedServersAfterJoin: remoteSendJoinResponse?.servers_in_room,
            },
            {
              localServerName: this.env.SERVER_NAME,
              now: () => Date.now(),
              getSharedRemoteServers: (sharedUserId) =>
                getSharedServersInRoomsWithUserIncludingPartialState(
                  this.env.DB,
                  this.env.CACHE,
                  sharedUserId,
                ),
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
      const parsed = parseMatrixErrorPayload(error);
      throw new RemoteJoinHttpError({
        operation: "make_join",
        destination: remoteServer,
        status: response.status,
        message: parsed.error ?? `make_join failed: ${response.status} ${error}`,
        ...withDefined("errcode", parsed.errcode),
      });
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

    const roomVersion = remoteEventTemplate?.room_version;
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

    const baseEvent = {
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

    const hash = await calculateContentHash(baseEvent as unknown as Record<string, unknown>);
    const eventWithHash = {
      ...baseEvent,
      hashes: { sha256: hash },
    };
    const eventId =
      (roomVersion ? getRoomVersion(roomVersion) : null)?.eventIdFormat === "v1"
        ? await generateEventId(this.env.SERVER_NAME, roomVersion)
        : await calculateReferenceHashEventId(
            eventWithHash as unknown as Record<string, unknown>,
            roomVersion,
          );

    const event: JoinWorkflowEvent = {
      event_id: eventId,
      ...eventWithHash,
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
    const v2Path = `/_matrix/federation/v2/send_join/${encodeURIComponent(roomId)}/${encodeURIComponent(joinEvent.event_id)}?omit_members=true`;
    const v1Path = `/_matrix/federation/v1/send_join/${encodeURIComponent(roomId)}/${encodeURIComponent(joinEvent.event_id)}?omit_members=true`;
    await runWorkflowEffect(
      logger.info("room_join.workflow.send_join_start", {
        v2_path: v2Path,
        v1_path: v1Path,
      }),
    );

    // Try v2 first (Matrix v1.1+), fall back to v1 if server returns 400/404
    let response = await federationPut(
      remoteServer,
      v2Path,
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
        v1Path,
        joinEvent,
        this.env.SERVER_NAME,
        this.env.DB,
        this.env.CACHE,
      );
    }

    if (!response.ok) {
      const error = await response.text();
      const parsed = parseMatrixErrorPayload(error);
      throw new RemoteJoinHttpError({
        operation: "send_join",
        destination: remoteServer,
        status: response.status,
        message: parsed.error ?? `send_join failed: ${response.status} ${error}`,
        ...withDefined("errcode", parsed.errcode),
      });
    }

    return toRemoteSendJoinResponse((await response.json()) as unknown);
  }

  private async fetchAndPersistPartialState(
    remoteServer: string,
    roomId: string,
    eventId: string,
    roomVersion: string,
  ): Promise<void> {
    const stateIdsResponse = await federationGet(
      remoteServer,
      `/_matrix/federation/v1/state_ids/${encodeURIComponent(roomId)}?event_id=${encodeURIComponent(eventId)}`,
      this.env.SERVER_NAME,
      this.env.DB,
      this.env.CACHE,
    );

    if (!stateIdsResponse.ok) {
      const error = await stateIdsResponse.text();
      throw new Error(`state_ids failed: ${stateIdsResponse.status} ${error}`);
    }

    const stateIds = (await stateIdsResponse.json()) as RemoteStateIdsResponse;
    if (!Array.isArray(stateIds.pdu_ids) || !Array.isArray(stateIds.auth_chain_ids)) {
      throw new Error("state_ids returned invalid response");
    }

    const stateResponse = await federationGet(
      remoteServer,
      `/_matrix/federation/v1/state/${encodeURIComponent(roomId)}?event_id=${encodeURIComponent(eventId)}`,
      this.env.SERVER_NAME,
      this.env.DB,
      this.env.CACHE,
    );

    if (!stateResponse.ok) {
      const error = await stateResponse.text();
      throw new Error(`state failed: ${stateResponse.status} ${error}`);
    }

    const statePayload = (await stateResponse.json()) as RemoteStateResponse;
    await persistFederationStateSnapshot(this.env.DB, {
      roomId,
      roomVersion,
      stateEvents: Array.isArray(statePayload.pdus) ? statePayload.pdus : [],
      authChain: Array.isArray(statePayload.auth_chain) ? statePayload.auth_chain : [],
      source: "workflow",
    });
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
