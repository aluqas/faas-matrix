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
} from "../services/database";
import {
  applyMembershipTransitionToDatabase,
  loadMembershipTransitionContext,
} from "../matrix/application/membership-transition-service";
import { persistFederationStateSnapshot } from "../matrix/application/federation-handler-service";

// Parameters passed when triggering the workflow
export interface JoinParams {
  roomId: string;
  userId: string;
  displayName?: string;
  avatarUrl?: string;
  isRemote: boolean;
  remoteServer?: string;
  remoteServers?: string[];
  reason?: string;
}

// Result returned when workflow completes
export interface JoinResult {
  eventId: string;
  roomId: string;
  success: boolean;
  error?: string;
}

// Serializable event data for workflow steps
// Using any for content to avoid TypeScript serialization issues with Cloudflare Workflows
interface SerializableEvent {
  event_id: string;
  room_id: string;
  sender: string;
  type: string;
  state_key?: string;
  content: any;
  origin_server_ts: number;
  depth: number;
  auth_events: string[];
  prev_events: string[];
  unsigned?: Record<string, unknown>;
}

export class RoomJoinWorkflow extends WorkflowEntrypoint<Env, JoinParams> {
  async run(event: WorkflowEvent<JoinParams>, step: WorkflowStep): Promise<JoinResult> {
    const { roomId, userId, isRemote, remoteServer, remoteServers, displayName, avatarUrl, reason } =
      event.payload;

    console.log("[RoomJoinWorkflow] Starting join", { roomId, userId, isRemote, remoteServer });

    try {
      // Step 1: For remote joins, get join template from remote server
      // Try each candidate server in order until one succeeds
      let remoteEventTemplate: { room_version: string; event: any } | null = null;
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
                console.warn("[RoomJoinWorkflow] make_join failed for", candidate, lastError.message);
              }
            }
            throw lastError ?? new Error("All remote servers failed for make_join");
          },
        )) as { room_version: string; event: any } | null;
      }

      // Step 2: Create and sign the join event
      const joinEventData = (await step.do("create-event", async () => {
        return await this.createJoinEvent({
          roomId,
          userId,
          displayName,
          avatarUrl,
          reason,
          remoteEventTemplate,
        });
      })) as SerializableEvent;

      // Step 3: For remote joins, send signed event to remote server and process room state
      if (isRemote && successfulRemoteServer && joinEventData) {
        const sendJoinResponse = (await step.do(
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
            return await this.sendJoinRequest(successfulRemoteServer!, roomId, joinEventData);
          },
        )) as { state?: any[]; auth_chain?: any[] } | null;

        // Process the room state received from the remote server
        await step.do("process-remote-state", async () => {
          const roomVersion = remoteEventTemplate?.room_version || "10";
          await persistFederationStateSnapshot(this.env.DB, {
            roomId,
            roomVersion,
            stateEvents: sendJoinResponse?.state || [],
            authChain: sendJoinResponse?.auth_chain || [],
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
          event: joinEventData as PDU,
          source: "workflow",
          context: transitionContext,
        });
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

      console.log("[RoomJoinWorkflow] Join completed successfully", {
        roomId,
        userId,
        eventId: joinEventData.event_id,
      });

      return {
        eventId: joinEventData.event_id,
        roomId,
        success: true,
      };
    } catch (error) {
      console.error("[RoomJoinWorkflow] Join failed", { roomId, userId, error });
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
  ): Promise<{ room_version: string; event: any }> {
    console.log("[RoomJoinWorkflow] Making make_join request", { remoteServer, roomId, userId });

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

    const result = (await response.json()) as { room_version: string; event: any };
    return result;
  }

  // Create a join event (either from remote template or local state)
  private async createJoinEvent(params: {
    roomId: string;
    userId: string;
    displayName?: string;
    avatarUrl?: string;
    reason?: string;
    remoteEventTemplate?: { room_version: string; event: any } | null;
  }): Promise<any> {
    const { roomId, userId, displayName, avatarUrl, reason, remoteEventTemplate } = params;

    let authEvents: string[] = [];
    let prevEvents: string[] = [];
    let depth = 1;
    let prevContent: Record<string, unknown> | undefined;
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
      prevContent = currentMembershipContent as Record<string, unknown>;
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

    const eventId = await generateEventId(this.env.SERVER_NAME);

    const memberContent: any = {
      membership: "join",
    };

    if (displayName) {
      memberContent.displayname = displayName;
    }
    if (avatarUrl) {
      memberContent.avatar_url = avatarUrl;
    }
    if (reason) {
      memberContent.reason = reason;
    }

    const event: SerializableEvent = {
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
      unsigned: prevContent
        ? {
            prev_content: prevContent,
            prev_sender: prevSender,
          }
        : undefined,
    };

    return event;
  }

  // Send a send_join request to a remote server
  private async sendJoinRequest(
    remoteServer: string,
    roomId: string,
    joinEvent: SerializableEvent,
  ): Promise<{ state?: any[]; auth_chain?: any[] }> {
    console.log("[RoomJoinWorkflow] Sending send_join request", {
      remoteServer,
      roomId,
      eventId: joinEvent.event_id,
    });

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
      console.log("[RoomJoinWorkflow] v2 send_join not supported, falling back to v1");
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

    const result = (await response.json()) as any;
    // v1 returns [200, {...}] array; v2 returns {...} directly
    if (Array.isArray(result)) {
      const [state, authChain] = result;
      return {
        state: Array.isArray(state) ? state : [],
        auth_chain: Array.isArray(authChain) ? authChain : [],
      };
    }

    return {
      state: Array.isArray(result?.state) ? result.state : [],
      auth_chain: Array.isArray(result?.auth_chain) ? result.auth_chain : [],
    };
  }

  // Notify a batch of members about the join
  private async notifyMemberBatch(
    members: Array<{ userId: string }>,
    joinEvent: SerializableEvent,
  ): Promise<void> {
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
        console.error("[RoomJoinWorkflow] Failed to notify member", {
          userId: member.userId,
          error: error instanceof Error ? error.message : "Unknown error",
        });
        // Don't throw - continue notifying other members
      }
    });

    await Promise.all(promises);
  }
}
