import type { AppContext } from "../../foundation/app-context";
import { withIdempotency, type IdempotencyStore } from "../../foundation/idempotency";
import { Errors, MatrixApiError } from "../../utils/errors";
import { getDefaultRoomVersion } from "../../services/room-versions";
import type { PDU } from "../../types";
import type { EventPipeline } from "../domain/event-pipeline";
import type { RoomRepository } from "../repositories/interfaces";
import {
  createInitialRoomEvents,
  createMembershipEvent,
  getServerFromRoomId,
} from "./rooms-support";
import { sendFederationInvite } from "../../services/federation-invite";
import { fanoutEventToRemoteServers } from "../../services/federation-fanout";
import {
  authorizeLocalJoin,
  getJoinRuleFromContent,
  validateLeavePreconditions,
} from "./room-membership-policy";
import { runDomainEffect } from "./domain-error";
import { validateCreateRoomRequest, validateJoinRoomRequest } from "./room-validation";

export interface CreateRoomInput {
  userId: string;
  body: unknown;
}

export interface JoinRoomInput {
  userId: string;
  roomId: string;
  remoteServers?: string[];
}

export interface SendEventInput {
  userId: string;
  roomId: string;
  eventType: string;
  txnId: string;
  content: Record<string, unknown>;
}

export interface LeaveRoomInput {
  userId: string;
  roomId: string;
}

type TransactionResponse = Record<string, unknown>;

export class MatrixRoomService {
  constructor(
    private readonly appContext: AppContext,
    private readonly repository: RoomRepository,
    private readonly eventPipeline: EventPipeline,
    private readonly idempotencyStore: IdempotencyStore<TransactionResponse>,
  ) {}

  async createRoom(input: CreateRoomInput): Promise<{ room_id: string; room_alias?: string }> {
    const validated = await runDomainEffect(validateCreateRoomRequest(input.body));
    const {
      room_alias_local_part,
      name,
      topic,
      invite,
      room_version,
      initial_state,
      preset,
      is_direct,
      visibility,
    } = validated;

    if (room_alias_local_part) {
      const alias = this.appContext.capabilities.id.formatRoomAlias(
        room_alias_local_part,
        this.appContext.capabilities.config.serverName,
      );
      const existingRoom = await this.repository.getRoomByAlias(alias);
      if (existingRoom) {
        throw Errors.roomInUse();
      }
    }

    const version = room_version || getDefaultRoomVersion();

    const roomId = await this.appContext.capabilities.id.generateRoomId(
      this.appContext.capabilities.config.serverName,
    );
    const isPublic = visibility === "public";
    await this.repository.createRoom(roomId, version, input.userId, isPublic);

    const createEventId = await createInitialRoomEvents(
      this.repository,
      this.appContext.capabilities.config.serverName,
      roomId,
      version,
      input.userId,
      {
        name,
        topic,
        preset,
        is_direct,
        initial_state: initial_state?.map((state) => ({
          type: state.type,
          state_key: state.state_key,
          content: { ...state.content },
        })),
        invite: invite ? [...invite] : undefined,
        room_alias_local_part,
      },
      this.appContext.capabilities.id.generateEventId,
      this.appContext.capabilities.clock.now,
    );

    await this.repository.upsertRoomAccountData(input.userId, roomId, "m.fully_read", {
      event_id: createEventId,
    });

    let roomAlias: string | undefined;
    if (room_alias_local_part) {
      roomAlias = this.appContext.capabilities.id.formatRoomAlias(
        room_alias_local_part,
        this.appContext.capabilities.config.serverName,
      );
      await this.repository.createRoomAlias(roomAlias, roomId, input.userId);
    }

    await this.repository.notifyUsersOfEvent(roomId, roomId, "m.room.create");

    if (Array.isArray(invite)) {
      const db = this.appContext.capabilities.sql.connection as D1Database;
      const cache = this.appContext.capabilities.kv.cache as KVNamespace;
      for (const invitee of invite) {
        const inviteEvent = await this.repository.getStateEvent(roomId, "m.room.member", invitee);
        if (!inviteEvent) {
          continue;
        }
        this.appContext.defer(
          sendFederationInvite(
            db,
            cache,
            this.appContext.capabilities.config.serverName,
            roomId,
            inviteEvent,
          ).catch((error) => {
            console.error("[room-service.createRoom] Failed to send federation invite:", error);
          }),
        );
      }
    }

    return {
      room_id: roomId,
      room_alias: roomAlias,
    };
  }

  async joinRoom(input: JoinRoomInput): Promise<{ room_id: string }> {
    const validated = await runDomainEffect(
      validateJoinRoomRequest({
        roomId: input.roomId,
        remoteServers: input.remoteServers,
      }),
    );
    const roomServer = getServerFromRoomId(validated.roomId);
    const isRemoteRoom =
      roomServer && roomServer !== this.appContext.capabilities.config.serverName;
    // Build ordered candidate list: explicit server_name hints first, then room ID server
    const explicitServers = validated.remoteServers;
    const roomServerIfDifferent =
      roomServer && !explicitServers.includes(roomServer) ? [roomServer] : [];
    const allRemoteServers = [...explicitServers, ...roomServerIfDifferent];
    const preferredRemoteServer = allRemoteServers[0] || undefined;
    const room = await this.repository.getRoom(validated.roomId);
    const createEvent = room
      ? await this.repository.getStateEvent(validated.roomId, "m.room.create")
      : null;
    const needsRemoteStubJoin = Boolean(
      room && (isRemoteRoom || preferredRemoteServer) && !createEvent,
    );

    if ((!room && (isRemoteRoom || preferredRemoteServer)) || needsRemoteStubJoin) {
      const instance = await this.appContext.capabilities.workflow.createRoomJoin({
        roomId: validated.roomId,
        userId: input.userId,
        isRemote: true,
        remoteServer: preferredRemoteServer,
        remoteServers: allRemoteServers.length > 0 ? allRemoteServers : undefined,
      });

      const status = (await instance) as
        | { status?: string; output?: { success?: boolean } }
        | undefined;

      if (!status || status.status === "running" || status.status === "queued") {
        return { room_id: validated.roomId };
      }

      if (status.status === "complete" && status.output?.success) {
        return { room_id: validated.roomId };
      }

      throw Errors.unknown("Failed to join remote room");
    }

    if (!room) {
      throw Errors.notFound("Room not found");
    }

    await this.eventPipeline.execute({
      input,
      validate: () => undefined,
      resolveAuth: async () => ({ userId: input.userId, roomVersion: room.room_version }),
      authorize: async (_pipelineInput, auth) => {
        const currentMembership = await this.repository.getMembership(validated.roomId, auth.userId);
        const joinRulesEvent = await this.repository.getStateEvent(
          validated.roomId,
          "m.room.join_rules",
        );
        await runDomainEffect(
          authorizeLocalJoin({
            roomVersion: auth.roomVersion,
            joinRule: getJoinRuleFromContent(
              joinRulesEvent?.content as { join_rule?: string } | undefined,
            ),
            currentMembership: currentMembership?.membership,
          }),
        );
      },
      buildEvent: async (_pipelineInput, auth) => {
        const currentMembership = await this.repository.getMembership(validated.roomId, auth.userId);
        if (currentMembership?.membership === "join") {
          return null;
        }

        const currentMembershipEvent = await this.repository.getStateEvent(
          validated.roomId,
          "m.room.member",
          auth.userId,
        );
        const joinRulesEvent = await this.repository.getStateEvent(
          validated.roomId,
          "m.room.join_rules",
        );
        const createEvent = await this.repository.getStateEvent(validated.roomId, "m.room.create");
        const powerLevelsEvent = await this.repository.getStateEvent(
          validated.roomId,
          "m.room.power_levels",
        );
        const latestEvents = await this.repository.getLatestRoomEvents(validated.roomId, 1);
        const currentMembershipContent = currentMembershipEvent?.content as
          | { membership?: unknown }
          | undefined;
        const prevContent =
          currentMembershipContent?.membership !== undefined
            ? (currentMembershipEvent?.content as Record<string, unknown>)
            : undefined;
        const prevSender = currentMembershipEvent?.sender;

        return createMembershipEvent({
          roomId: validated.roomId,
          userId: auth.userId,
          sender: auth.userId,
          membership: "join",
          serverName: this.appContext.capabilities.config.serverName,
          generateEventId: this.appContext.capabilities.id.generateEventId,
          now: this.appContext.capabilities.clock.now,
          roomVersion: auth.roomVersion,
          currentMembershipEventId: currentMembership?.eventId,
          joinRulesEventId: joinRulesEvent?.event_id,
          powerLevelsEventId: powerLevelsEvent?.event_id,
          createEventId: createEvent?.event_id,
          prevEventIds: latestEvents.map((event) => event.event_id),
          depth: (latestEvents[0]?.depth ?? 0) + 1,
          unsigned: prevContent
            ? {
                prev_content: prevContent,
                prev_sender: prevSender,
              }
            : undefined,
        });
      },
      persist: async (_pipelineInput, _auth, event) => {
        if (!event) {
          return { alreadyJoined: true };
        }

        await this.repository.persistMembershipEvent(validated.roomId, event, "client");
        return { eventId: event.event_id, alreadyJoined: false };
      },
      fanout: async (_pipelineInput, _auth, event, persisted) => {
        if (!event || persisted.alreadyJoined) {
          return;
        }
        await this.repository.notifyUsersOfEvent(validated.roomId, event.event_id, "m.room.member");
        const db = this.appContext.capabilities.sql.connection as D1Database;
        const cache = this.appContext.capabilities.kv.cache as KVNamespace;
        this.appContext.defer(
          fanoutEventToRemoteServers(
            db,
            cache,
            this.appContext.capabilities.config.serverName,
            validated.roomId,
            event,
          ).catch((error) => {
            console.error("[room-service.joinRoom] Failed to fan out join event:", error);
          }),
        );
      },
    });

    return { room_id: validated.roomId };
  }

  async leaveRoom(input: LeaveRoomInput): Promise<void> {
    await this.eventPipeline.execute({
      input,
      validate: () => undefined,
      resolveAuth: async () => ({ userId: input.userId }),
      authorize: async (_pipelineInput, auth) => {
        const membership = await this.repository.getMembership(input.roomId, auth.userId);
        await runDomainEffect(validateLeavePreconditions(membership?.membership));
      },
      buildEvent: async (_pipelineInput, auth) => {
        const currentMembership = await this.repository.getMembership(input.roomId, auth.userId);
        const createEvent = await this.repository.getStateEvent(input.roomId, "m.room.create");
        const powerLevelsEvent = await this.repository.getStateEvent(
          input.roomId,
          "m.room.power_levels",
        );
        const currentMembershipEvent = await this.repository.getStateEvent(
          input.roomId,
          "m.room.member",
          auth.userId,
        );
        const latestEvents = await this.repository.getLatestRoomEvents(input.roomId, 1);
        const currentMembershipContent = currentMembershipEvent?.content as
          | { membership?: unknown }
          | undefined;
        const prevContent =
          currentMembershipContent?.membership !== undefined
            ? (currentMembershipEvent?.content as Record<string, unknown>)
            : undefined;
        const prevSender = currentMembershipEvent?.sender;

        return createMembershipEvent({
          roomId: input.roomId,
          userId: auth.userId,
          sender: auth.userId,
          membership: "leave",
          serverName: this.appContext.capabilities.config.serverName,
          generateEventId: this.appContext.capabilities.id.generateEventId,
          now: this.appContext.capabilities.clock.now,
          currentMembershipEventId: currentMembership?.eventId,
          powerLevelsEventId: powerLevelsEvent?.event_id,
          createEventId: createEvent?.event_id,
          prevEventIds: latestEvents.map((event) => event.event_id),
          depth: (latestEvents[0]?.depth ?? 0) + 1,
          unsigned: prevContent
            ? {
                prev_content: prevContent,
                prev_sender: prevSender,
              }
            : undefined,
        });
      },
      persist: async (_pipelineInput, _auth, event) => {
        await this.repository.persistMembershipEvent(input.roomId, event, "client");
        return { eventId: event.event_id };
      },
      fanout: async (_pipelineInput, _auth, event) => {
        await this.repository.notifyUsersOfEvent(input.roomId, event.event_id, "m.room.member");
        const db = this.appContext.capabilities.sql.connection as D1Database;
        const cache = this.appContext.capabilities.kv.cache as KVNamespace;
        this.appContext.defer(
          fanoutEventToRemoteServers(
            db,
            cache,
            this.appContext.capabilities.config.serverName,
            input.roomId,
            event,
          ).catch((error) => {
            console.error("[room-service.leaveRoom] Failed to fan out leave event:", error);
          }),
        );
      },
    });
  }

  async sendEvent(input: SendEventInput): Promise<{ event_id: string }> {
    const response = await withIdempotency(
      this.idempotencyStore,
      input.userId,
      input.txnId,
      async () => {
        const result = await this.eventPipeline.execute({
          input,
          validate: () => {
            if (!input.eventType) {
              throw Errors.missingParam("eventType");
            }
          },
          resolveAuth: async () => ({ userId: input.userId }),
          authorize: async (_pipelineInput, auth) => {
            const membership = await this.repository.getMembership(input.roomId, auth.userId);
            if (!membership || membership.membership !== "join") {
              throw Errors.forbidden("Not a member of this room");
            }
          },
          buildEvent: async (_pipelineInput, auth) => {
            const membership = await this.repository.getMembership(input.roomId, auth.userId);
            const createEvent = await this.repository.getStateEvent(input.roomId, "m.room.create");
            const powerLevelsEvent = await this.repository.getStateEvent(
              input.roomId,
              "m.room.power_levels",
            );
            const latestEvents = await this.repository.getLatestRoomEvents(input.roomId, 1);

            const authEvents: string[] = [];
            if (createEvent) authEvents.push(createEvent.event_id);
            if (powerLevelsEvent) authEvents.push(powerLevelsEvent.event_id);
            if (membership) authEvents.push(membership.eventId);

            const event: PDU = {
              event_id: await this.appContext.capabilities.id.generateEventId(
                this.appContext.capabilities.config.serverName,
              ),
              room_id: input.roomId,
              sender: auth.userId,
              type: input.eventType,
              content: input.content,
              origin_server_ts: this.appContext.capabilities.clock.now(),
              unsigned: { transaction_id: input.txnId },
              depth: (latestEvents[0]?.depth ?? 0) + 1,
              auth_events: authEvents,
              prev_events: latestEvents.map((eventRecord) => eventRecord.event_id),
            };

            return event;
          },
          persist: async (_pipelineInput, _auth, event) => {
            await this.repository.storeEvent(event);
            return { eventId: event.event_id };
          },
          fanout: async (_pipelineInput, _auth, event) => {
            await this.repository.notifyUsersOfEvent(input.roomId, event.event_id, input.eventType);
          },
          notifyFederation: async (_pipelineInput, _auth, event) => {
            if (
              this.appContext.profile.features.pushNotifications &&
              (input.eventType === "m.room.message" || input.eventType === "m.room.encrypted")
            ) {
              this.appContext.defer(
                this.appContext.capabilities.workflow
                  .createPushNotification({
                    eventId: event.event_id,
                    roomId: input.roomId,
                    eventType: input.eventType,
                    sender: input.userId,
                    content: input.content,
                    originServerTs: event.origin_server_ts,
                  })
                  .then(() => undefined),
              );
            }
          },
        });

        const eventId = result.persisted.eventId;
        if (typeof eventId !== "string") {
          throw new MatrixApiError("M_UNKNOWN", "Event persistence failed", 500);
        }
        return { event_id: eventId };
      },
    );
    return response as { event_id: string };
  }
}
