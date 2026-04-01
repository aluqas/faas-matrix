import type { AppContext } from "../../foundation/app-context";
import { withIdempotency, type IdempotencyStore } from "../../foundation/idempotency";
import { Errors, MatrixApiError } from "../../utils/errors";
import { getDefaultRoomVersion, getRoomVersion } from "../../services/room-versions";
import type { PDU, RoomJoinWorkflowStatus, RoomPowerLevelsContent } from "../../types";
import type { EventPipeline } from "../domain/event-pipeline";
import type { RoomRepository } from "../repositories/interfaces";
import {
  createInitialRoomEvents,
  createMembershipEvent,
  getServerFromRoomId,
} from "./rooms-support";
import { sendFederationInvite } from "../../services/federation-invite";
import { getServerSigningKey } from "../../services/federation-keys";
import { fanoutEventToRemoteServers } from "../../services/federation-fanout";
import { getServersInRoomsWithUser, getUserDevices } from "../../services/database";
import {
  calculateContentHash,
  calculateReferenceHashEventId,
  canonicalJson,
  signJson,
} from "../../utils/crypto";
import { parseUserId } from "../../utils/ids";
import { parseDeviceKeysPayload } from "../../api/keys-contracts";
import {
  authorizeBan,
  authorizeKick,
  authorizeLocalInvite,
  authorizeLocalJoin,
  getJoinRuleFromContent,
  authorizeUnban,
  validateLeavePreconditions,
} from "./room-membership-policy";
import { requireRoomVersionPolicy } from "./room-version-policy";
import { runClientEffect } from "./effect-runtime";
import { emitEffectWarning } from "./effect-debug";
import { withLogContext, type LogContext } from "./logging";
import { DomainError, toMatrixApiError } from "./domain-error";
import {
  validateCreateRoomRequest,
  validateInviteRoomRequest,
  validateJoinRoomRequest,
  validateModerationRequest,
} from "./room-validation";
import { publishDeviceListUpdatesForNewlySharedServers } from "./features/device-lists/command";
import {
  decideInvitePermission,
  loadInvitePermissionConfig,
} from "./features/invite-permissions/policy";
import { authorizeOwnedStateEvent } from "./features/owned-state/policy";

export interface CreateRoomInput {
  userId: string;
  body: unknown;
}

export interface JoinRoomInput {
  userId: string;
  roomId: string;
  remoteServers?: string[];
  body?: unknown;
}

export interface SendEventInput {
  userId: string;
  roomId: string;
  eventType: string;
  stateKey?: string;
  txnId: string;
  content: Record<string, unknown>;
}

export interface LeaveRoomInput {
  userId: string;
  roomId: string;
}

export interface InviteRoomInput {
  userId: string;
  roomId: string;
  targetUserId: string;
}

export interface ModerateRoomInput {
  userId: string;
  roomId: string;
  targetUserId: string;
  reason?: string;
}

type TransactionResponse = Record<string, unknown>;

function withOptionalValue<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  if (value === undefined) {
    return {};
  }

  return { [key]: value } as { [P in K]?: V };
}

function isD1Database(value: unknown): value is D1Database {
  return (
    value !== null &&
    typeof value === "object" &&
    "prepare" in value &&
    typeof (value as { prepare?: unknown }).prepare === "function"
  );
}

function getPowerLevelsContent(powerLevelsEvent: PDU | null): RoomPowerLevelsContent {
  const content = powerLevelsEvent?.content;
  if (!content || typeof content !== "object") {
    return {
      users_default: 0,
      events_default: 0,
      state_default: 50,
      ban: 50,
      kick: 50,
      redact: 50,
      invite: 0,
      users: {},
      events: {},
    };
  }

  return content as RoomPowerLevelsContent;
}

function getUserPowerLevel(powerLevels: RoomPowerLevelsContent, userId: string): number {
  return (
    powerLevels.users?.[userId as keyof typeof powerLevels.users] ?? powerLevels.users_default ?? 0
  );
}

function getRequiredEventPowerLevel(
  powerLevels: RoomPowerLevelsContent,
  eventType: string,
  isStateEvent: boolean,
): number {
  const eventLevel = powerLevels.events?.[eventType];
  if (typeof eventLevel === "number") {
    return eventLevel;
  }

  return isStateEvent ? (powerLevels.state_default ?? 50) : (powerLevels.events_default ?? 0);
}

async function getStoredDeviceKeysFromKv(
  kv: KVNamespace | undefined,
  userId: string,
  deviceId: string,
) {
  if (!kv) {
    return null;
  }

  return parseDeviceKeysPayload(await kv.get(`device:${userId}:${deviceId}`, "json"));
}

async function attachFederationMetadata(
  db: D1Database | undefined,
  serverName: string,
  event: PDU,
  roomVersion?: string,
): Promise<PDU> {
  const roomVersionBehavior = roomVersion ? getRoomVersion(roomVersion) : null;
  const hash =
    event.hashes?.sha256 ??
    (await calculateContentHash(
      (roomVersionBehavior?.eventIdFormat === "v1"
        ? event
        : { ...event, event_id: undefined }) as unknown as Record<string, unknown>,
    ));
  if (!db) {
    return {
      ...event,
      hashes: { sha256: hash },
    };
  }
  const signingKey = await getServerSigningKey(db);
  if (!signingKey) {
    throw new MatrixApiError("M_UNKNOWN", "Server signing key not configured", 500);
  }

  const signingPayload: Record<string, unknown> = {
    ...event,
    hashes: { sha256: hash },
  };
  if (roomVersionBehavior?.eventIdFormat !== "v1") {
    delete signingPayload["event_id"];
  }

  const signed = await signJson(
    signingPayload,
    serverName,
    signingKey.keyId,
    signingKey.privateKeyJwk,
  );

  const signatures = signed["signatures"] as Record<string, Record<string, string>> | undefined;

  return {
    ...event,
    hashes: { sha256: hash },
    ...withOptionalValue("signatures", signatures),
  };
}

export class MatrixRoomService {
  constructor(
    private readonly appContext: AppContext,
    private readonly repository: RoomRepository,
    private readonly eventPipeline: EventPipeline,
    private readonly idempotencyStore: IdempotencyStore<TransactionResponse>,
  ) {}

  private createLogger(
    operation: string,
    context: Omit<LogContext, "component" | "operation" | "debugEnabled"> = {},
  ) {
    return withLogContext({
      component: "room-service",
      operation,
      debugEnabled: this.appContext.profile.name !== "lite",
      ...context,
    });
  }

  async createRoom(input: CreateRoomInput): Promise<{ room_id: string; room_alias?: string }> {
    const logger = this.createLogger("create_room", { user_id: input.userId });
    const validated = await runClientEffect(validateCreateRoomRequest(input.body));
    const {
      room_alias_local_part,
      room_alias_name,
      name,
      topic,
      invite,
      room_version,
      creation_content,
      initial_state,
      preset,
      is_direct,
      visibility,
    } = validated;
    const roomAliasLocalPart = room_alias_local_part ?? room_alias_name;
    await runClientEffect(
      logger.info("room.command.start", {
        command: "create_room",
        invite_count: invite?.length ?? 0,
        room_version: room_version ?? getDefaultRoomVersion(),
        visibility,
        has_alias: Boolean(roomAliasLocalPart),
      }),
    );

    if (roomAliasLocalPart) {
      const alias = this.appContext.capabilities.id.formatRoomAlias(
        roomAliasLocalPart,
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
        ...withOptionalValue("name", name),
        ...withOptionalValue("topic", topic),
        ...withOptionalValue("preset", preset),
        ...withOptionalValue("is_direct", is_direct),
        ...withOptionalValue("creation_content", creation_content),
        ...withOptionalValue(
          "initial_state",
          initial_state?.map((state) => ({
            type: state.type,
            content: { ...state.content },
            ...withOptionalValue("state_key", state.state_key),
          })),
        ),
        ...withOptionalValue("invite", invite ? [...invite] : undefined),
        ...withOptionalValue("room_alias_local_part", roomAliasLocalPart),
      },
      this.appContext.capabilities.id.generateEventId,
      this.appContext.capabilities.clock.now,
    );

    await this.repository.upsertRoomAccountData(input.userId, roomId, "m.fully_read", {
      event_id: createEventId,
    });

    let roomAlias: string | undefined;
    if (roomAliasLocalPart) {
      roomAlias = this.appContext.capabilities.id.formatRoomAlias(
        roomAliasLocalPart,
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
            void runClientEffect(
              logger.error("room.command.async_error", error, {
                command: "create_room",
                room_id: roomId,
                target_user_id: invitee,
                phase: "send_federation_invite",
              }),
            );
          }),
        );
      }
    }

    await runClientEffect(
      logger.info("room.command.success", {
        command: "create_room",
        room_id: roomId,
        room_alias: roomAlias,
      }),
    );

    return { room_id: roomId, ...withOptionalValue("room_alias", roomAlias) };
  }

  async joinRoom(input: JoinRoomInput): Promise<{ room_id: string }> {
    const logger = this.createLogger("join_room", {
      room_id: input.roomId,
      user_id: input.userId,
    });
    const db = isD1Database(this.appContext.capabilities.sql.connection)
      ? this.appContext.capabilities.sql.connection
      : undefined;
    const cache = this.appContext.capabilities.kv.cache as KVNamespace;
    const deviceKeysKv = this.appContext.capabilities.kv.deviceKeys as KVNamespace | undefined;
    const preJoinSharedServers = db ? await getServersInRoomsWithUser(db, input.userId) : [];
    const validated = await runClientEffect(
      validateJoinRoomRequest({
        roomId: input.roomId,
        ...withOptionalValue("remoteServers", input.remoteServers),
        ...withOptionalValue("content", input.body as Record<string, unknown> | undefined),
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
    await runClientEffect(
      logger.info("room.command.start", {
        command: "join_room",
        is_remote_room: isRemoteRoom,
        remote_server_count: allRemoteServers.length,
        needs_remote_stub_join: needsRemoteStubJoin,
      }),
    );

    if ((!room && (isRemoteRoom || preferredRemoteServer)) || needsRemoteStubJoin) {
      const status: RoomJoinWorkflowStatus =
        await this.appContext.capabilities.workflow.createRoomJoin({
          roomId: validated.roomId,
          userId: input.userId,
          isRemote: true,
          ...withOptionalValue("remoteServer", preferredRemoteServer),
          ...withOptionalValue(
            "remoteServers",
            allRemoteServers.length > 0 ? allRemoteServers : undefined,
          ),
        });

      if (!status || status.status === "running" || status.status === "queued") {
        await runClientEffect(
          logger.info("room.command.success", {
            command: "join_room",
            room_id: validated.roomId,
            workflow_status: status?.status ?? "unknown",
          }),
        );
        return { room_id: validated.roomId };
      }

      if (status.status === "complete" && status.output?.success) {
        await runClientEffect(
          logger.info("room.command.success", {
            command: "join_room",
            room_id: validated.roomId,
            workflow_status: status.status,
          }),
        );
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
        const currentMembership = await this.repository.getMembership(
          validated.roomId,
          auth.userId,
        );
        const joinRulesEvent = await this.repository.getStateEvent(
          validated.roomId,
          "m.room.join_rules",
        );
        await runClientEffect(
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
        const currentMembership = await this.repository.getMembership(
          validated.roomId,
          auth.userId,
        );
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
          ...withOptionalValue("roomVersion", auth.roomVersion),
          ...withOptionalValue("currentMembershipEventId", currentMembership?.eventId),
          ...withOptionalValue("joinRulesEventId", joinRulesEvent?.event_id),
          ...withOptionalValue("powerLevelsEventId", powerLevelsEvent?.event_id),
          ...withOptionalValue("createEventId", createEvent?.event_id),
          prevEventIds: latestEvents.map((event) => event.event_id),
          depth: (latestEvents[0]?.depth ?? 0) + 1,
          ...withOptionalValue("content", validated.content),
          ...withOptionalValue(
            "unsigned",
            prevContent
              ? {
                  prev_content: prevContent,
                  ...withOptionalValue("prev_sender", prevSender),
                }
              : undefined,
          ),
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
        this.appContext.defer(
          (async () => {
            try {
              if (!db) {
                return;
              }

              await fanoutEventToRemoteServers(
                db,
                cache,
                this.appContext.capabilities.config.serverName,
                validated.roomId,
                event,
              );

              const queueEdu = this.appContext.capabilities.federation?.queueEdu;
              if (!queueEdu) {
                return;
              }

              const published = await publishDeviceListUpdatesForNewlySharedServers(
                {
                  userId: input.userId,
                  previouslySharedServers: preJoinSharedServers,
                },
                {
                  localServerName: this.appContext.capabilities.config.serverName,
                  now: () => this.appContext.capabilities.clock.now(),
                  getSharedRemoteServers: (userId) =>
                    db ? getServersInRoomsWithUser(db, userId) : Promise.resolve([]),
                  getUserDevices: (userId) =>
                    db ? getUserDevices(db, userId) : Promise.resolve([]),
                  getStoredDeviceKeys: (userId, deviceId) =>
                    getStoredDeviceKeysFromKv(deviceKeysKv, userId, deviceId),
                  queueEdu,
                },
              );

              if (published.sentCount > 0) {
                await runClientEffect(
                  logger.info("room.command.device_list_shared", {
                    command: "join_room",
                    room_id: validated.roomId,
                    user_id: input.userId,
                    destination_count: published.destinations.length,
                    device_count: published.deviceCount,
                    sent_count: published.sentCount,
                  }),
                );
              }
            } catch (error) {
              void runClientEffect(
                logger.error("room.command.async_error", error, {
                  command: "join_room",
                  room_id: validated.roomId,
                  event_id: event.event_id,
                  phase: "fanout_join",
                }),
              );
            }
          })(),
        );
      },
    });

    await runClientEffect(
      logger.info("room.command.success", {
        command: "join_room",
        room_id: validated.roomId,
      }),
    );

    return { room_id: validated.roomId };
  }

  async leaveRoom(input: LeaveRoomInput): Promise<void> {
    const logger = this.createLogger("leave_room", {
      room_id: input.roomId,
      user_id: input.userId,
    });
    await runClientEffect(
      logger.info("room.command.start", {
        command: "leave_room",
      }),
    );
    await this.eventPipeline.execute({
      input,
      validate: () => undefined,
      resolveAuth: async () => ({ userId: input.userId }),
      authorize: async (_pipelineInput, auth) => {
        const membership = await this.repository.getMembership(input.roomId, auth.userId);
        await runClientEffect(validateLeavePreconditions(membership?.membership));
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
          ...withOptionalValue("currentMembershipEventId", currentMembership?.eventId),
          ...withOptionalValue("powerLevelsEventId", powerLevelsEvent?.event_id),
          ...withOptionalValue("createEventId", createEvent?.event_id),
          prevEventIds: latestEvents.map((event) => event.event_id),
          depth: (latestEvents[0]?.depth ?? 0) + 1,
          ...withOptionalValue(
            "unsigned",
            prevContent
              ? {
                  prev_content: prevContent,
                  ...withOptionalValue("prev_sender", prevSender),
                }
              : undefined,
          ),
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
            void runClientEffect(
              logger.error("room.command.async_error", error, {
                command: "leave_room",
                room_id: input.roomId,
                event_id: event.event_id,
                phase: "fanout_leave",
              }),
            );
          }),
        );
      },
    });
    await runClientEffect(
      logger.info("room.command.success", {
        command: "leave_room",
      }),
    );
  }

  async inviteRoom(input: InviteRoomInput): Promise<void> {
    const logger = this.createLogger("invite_room", {
      room_id: input.roomId,
      user_id: input.userId,
    });
    const validated = await runClientEffect(
      validateInviteRoomRequest({
        roomId: input.roomId,
        targetUserId: input.targetUserId,
      }),
    );
    await runClientEffect(
      logger.info("room.command.start", {
        command: "invite_room",
        target_user_id: validated.targetUserId,
      }),
    );

    await this.eventPipeline.execute({
      input,
      validate: () => undefined,
      resolveAuth: async () => ({ userId: input.userId }),
      authorize: async (_pipelineInput, auth) => {
        const inviterMembership = await this.repository.getMembership(
          validated.roomId,
          auth.userId,
        );
        const inviteeMembership = await this.repository.getMembership(
          validated.roomId,
          validated.targetUserId,
        );
        const powerLevelsEvent = await this.repository.getStateEvent(
          validated.roomId,
          "m.room.power_levels",
        );
        const powerLevels =
          (powerLevelsEvent?.content as Record<string, unknown> | undefined) ?? {};
        const users = (powerLevels["users"] as Record<string, number> | undefined) ?? {};
        const usersDefault =
          typeof powerLevels["users_default"] === "number" ? powerLevels["users_default"] : 0;
        const inviterPower = users[auth.userId] ?? usersDefault;
        const invitePower = typeof powerLevels["invite"] === "number" ? powerLevels["invite"] : 50;

        if (inviteeMembership?.membership === "invite") {
          return;
        }

        await runClientEffect(
          authorizeLocalInvite({
            inviterMembership: inviterMembership?.membership,
            inviteeMembership: inviteeMembership?.membership,
            inviterPower,
            invitePower,
          }),
        );
      },
      buildEvent: async (_pipelineInput, auth) => {
        const inviteeMembership = await this.repository.getMembership(
          validated.roomId,
          validated.targetUserId,
        );
        if (inviteeMembership?.membership === "invite") {
          return null;
        }

        const createEvent = await this.repository.getStateEvent(validated.roomId, "m.room.create");
        const powerLevelsEvent = await this.repository.getStateEvent(
          validated.roomId,
          "m.room.power_levels",
        );
        const inviterMembership = await this.repository.getMembership(
          validated.roomId,
          auth.userId,
        );
        const latestEvents = await this.repository.getLatestRoomEvents(validated.roomId, 1);

        return createMembershipEvent({
          roomId: validated.roomId,
          userId: validated.targetUserId,
          sender: auth.userId,
          membership: "invite",
          serverName: this.appContext.capabilities.config.serverName,
          generateEventId: this.appContext.capabilities.id.generateEventId,
          now: this.appContext.capabilities.clock.now,
          ...withOptionalValue("createEventId", createEvent?.event_id),
          ...withOptionalValue("powerLevelsEventId", powerLevelsEvent?.event_id),
          ...withOptionalValue("currentMembershipEventId", inviterMembership?.eventId),
          prevEventIds: latestEvents.map((event) => event.event_id),
          depth: (latestEvents[0]?.depth ?? 0) + 1,
        });
      },
      persist: async (_pipelineInput, _auth, event) => {
        if (!event) {
          return { alreadyInvited: true };
        }

        const db = isD1Database(this.appContext.capabilities.sql.connection)
          ? this.appContext.capabilities.sql.connection
          : undefined;
        const cache = this.appContext.capabilities.kv.cache as KVNamespace | undefined;
        const targetUser = parseUserId(validated.targetUserId);
        const isLocalTarget =
          targetUser?.serverName === this.appContext.capabilities.config.serverName;

        if (db && isLocalTarget) {
          const invitePermissionConfig = await loadInvitePermissionConfig(
            db,
            validated.targetUserId,
          );
          const decision = decideInvitePermission(invitePermissionConfig, input.userId);
          if (decision.action === "block") {
            await runClientEffect(
              logger.warn("room.command.decision", {
                command: "invite_room",
                decision: "invite_blocked",
                target_user_id: validated.targetUserId,
                matched_by: decision.matchedBy,
                matched_value: decision.matchedValue,
              }),
            );
            throw Errors.inviteBlocked();
          }
        }

        if (db && cache) {
          await sendFederationInvite(
            db,
            cache,
            this.appContext.capabilities.config.serverName,
            validated.roomId,
            event,
          );
        }

        await this.repository.persistMembershipEvent(validated.roomId, event, "client");
        return { eventId: event.event_id, alreadyInvited: false };
      },
      fanout: async (_pipelineInput, _auth, event, persisted) => {
        if (!event || persisted.alreadyInvited) {
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
            void runClientEffect(
              logger.error("room.command.async_error", error, {
                command: "invite_room",
                room_id: validated.roomId,
                event_id: event.event_id,
                target_user_id: validated.targetUserId,
                phase: "fanout_invite",
              }),
            );
          }),
        );
      },
    });
    await runClientEffect(
      logger.info("room.command.success", {
        command: "invite_room",
        target_user_id: validated.targetUserId,
      }),
    );
  }

  async kickUser(input: ModerateRoomInput): Promise<void> {
    const validated = await runClientEffect(validateModerationRequest(input));
    await this.executeModerationAction({
      actorUserId: input.userId,
      roomId: validated.roomId,
      targetUserId: validated.targetUserId,
      membership: "leave",
      ...withOptionalValue("reason", validated.reason),
      authorize: async (context) => {
        await runClientEffect(
          authorizeKick({
            actorMembership: context.actorMembership?.membership,
            targetMembership: context.targetMembership?.membership,
            actorPower: context.actorPower,
            targetPower: context.targetPower,
            kickPower: context.kickPower,
            canRescindInvite: context.targetMembershipEvent?.sender === input.userId,
          }),
        );
      },
    });
  }

  async banUser(input: ModerateRoomInput): Promise<void> {
    const validated = await runClientEffect(validateModerationRequest(input));
    await this.executeModerationAction({
      actorUserId: input.userId,
      roomId: validated.roomId,
      targetUserId: validated.targetUserId,
      membership: "ban",
      ...withOptionalValue("reason", validated.reason),
      authorize: async (context) => {
        await runClientEffect(
          authorizeBan({
            actorMembership: context.actorMembership?.membership,
            actorPower: context.actorPower,
            targetPower: context.targetPower,
            banPower: context.banPower,
          }),
        );
      },
    });
  }

  async unbanUser(input: ModerateRoomInput): Promise<void> {
    const validated = await runClientEffect(validateModerationRequest(input));
    await this.executeModerationAction({
      actorUserId: input.userId,
      roomId: validated.roomId,
      targetUserId: validated.targetUserId,
      membership: "leave",
      ...withOptionalValue("reason", validated.reason),
      authorize: async (context) => {
        await runClientEffect(
          authorizeUnban({
            actorMembership: context.actorMembership?.membership,
            targetMembership: context.targetMembership?.membership,
            actorPower: context.actorPower,
            banPower: context.banPower,
          }),
        );
      },
    });
  }

  async sendEvent(input: SendEventInput): Promise<{ event_id: string }> {
    const logger = this.createLogger("send_event", {
      room_id: input.roomId,
      user_id: input.userId,
    });
    await runClientEffect(
      logger.info("room.command.start", {
        command: "send_event",
        event_type: input.eventType,
        state_key: input.stateKey,
        txn_id: input.txnId,
      }),
    );
    try {
      const response = await withIdempotency(
        this.idempotencyStore,
        input.userId,
        input.txnId,
        async () => {
          if (input.stateKey !== undefined) {
            const existingStateEvent = await this.repository.getStateEvent(
              input.roomId,
              input.eventType,
              input.stateKey,
            );
            if (
              existingStateEvent &&
              existingStateEvent.sender === input.userId &&
              canonicalJson(existingStateEvent.content) === canonicalJson(input.content)
            ) {
              await runClientEffect(
                logger.info("room.command.success", {
                  command: "send_event",
                  room_id: input.roomId,
                  event_type: input.eventType,
                  state_key: input.stateKey,
                  event_id: existingStateEvent.event_id,
                  idempotent: true,
                }),
              );
              return { event_id: existingStateEvent.event_id };
            }
          }

          const result = await this.eventPipeline.execute({
            input,
            validate: () => {
              if (!input.eventType) {
                throw Errors.missingParam("eventType");
              }
            },
            resolveAuth: async () => {
              const room = await this.repository.getRoom(input.roomId);
              if (!room) {
                throw Errors.notFound("Room not found");
              }
              return {
                userId: input.userId,
                roomVersion: room.room_version,
              };
            },
            authorize: async (_pipelineInput, auth) => {
              const membership = await this.repository.getMembership(input.roomId, auth.userId);
              if (!membership || membership.membership !== "join") {
                throw Errors.forbidden("Not a member of this room");
              }

              if (input.stateKey?.startsWith("@")) {
                const powerLevelsEvent = await this.repository.getStateEvent(
                  input.roomId,
                  "m.room.power_levels",
                );
                const powerLevels = getPowerLevelsContent(powerLevelsEvent);
                authorizeOwnedStateEvent({
                  policy: requireRoomVersionPolicy(auth.roomVersion),
                  eventType: input.eventType,
                  stateKey: input.stateKey,
                  senderUserId: auth.userId,
                  actorPower: getUserPowerLevel(powerLevels, auth.userId),
                  requiredEventPower: getRequiredEventPowerLevel(
                    powerLevels,
                    input.eventType,
                    input.stateKey !== undefined,
                  ),
                });
              }
            },
            buildEvent: async (_pipelineInput, auth) => {
              const membership = await this.repository.getMembership(input.roomId, auth.userId);
              const createEvent = await this.repository.getStateEvent(
                input.roomId,
                "m.room.create",
              );
              const powerLevelsEvent = await this.repository.getStateEvent(
                input.roomId,
                "m.room.power_levels",
              );
              const latestEvents = await this.repository.getLatestRoomEvents(input.roomId, 1);

              const authEvents: string[] = [];
              if (createEvent) authEvents.push(createEvent.event_id);
              if (powerLevelsEvent) authEvents.push(powerLevelsEvent.event_id);
              if (membership) authEvents.push(membership.eventId);

              const baseEvent = {
                room_id: input.roomId,
                sender: auth.userId,
                type: input.eventType,
                ...withOptionalValue("state_key", input.stateKey),
                content: input.content,
                origin_server_ts: this.appContext.capabilities.clock.now(),
                unsigned: { transaction_id: input.txnId },
                depth: (latestEvents[0]?.depth ?? 0) + 1,
                auth_events: authEvents,
                prev_events: latestEvents.map((eventRecord) => eventRecord.event_id),
              };
              const hash = await calculateContentHash(
                baseEvent as unknown as Record<string, unknown>,
              );
              const eventWithHash = {
                ...baseEvent,
                hashes: { sha256: hash },
              };
              const eventId =
                getRoomVersion(auth.roomVersion)?.eventIdFormat === "v1"
                  ? await this.appContext.capabilities.id.generateEventId(
                      this.appContext.capabilities.config.serverName,
                      auth.roomVersion,
                    )
                  : await calculateReferenceHashEventId(
                      eventWithHash as unknown as Record<string, unknown>,
                      auth.roomVersion,
                    );

              const event: PDU = {
                event_id: eventId,
                ...eventWithHash,
              };

              return event;
            },
            persist: async (_pipelineInput, _auth, event) => {
              await this.repository.storeEvent(event);
              return { eventId: event.event_id };
            },
            fanout: async (_pipelineInput, _auth, event) => {
              await this.repository.notifyUsersOfEvent(
                input.roomId,
                event.event_id,
                input.eventType,
              );
            },
            notifyFederation: async (_pipelineInput, auth, event) => {
              this.appContext.defer(
                (async () => {
                  if (
                    this.appContext.profile.features.pushNotifications &&
                    (input.eventType === "m.room.message" || input.eventType === "m.room.encrypted")
                  ) {
                    await this.appContext.capabilities.workflow.createPushNotification({
                      eventId: event.event_id,
                      roomId: input.roomId,
                      eventType: input.eventType,
                      sender: input.userId,
                      content: input.content,
                      originServerTs: event.origin_server_ts,
                    });
                  }

                  const federatedEvent = await attachFederationMetadata(
                    isD1Database(this.appContext.capabilities.sql.connection)
                      ? this.appContext.capabilities.sql.connection
                      : undefined,
                    this.appContext.capabilities.config.serverName,
                    event,
                    auth.roomVersion,
                  );
                  await emitEffectWarning("[room-service] federating event", {
                    roomId: input.roomId,
                    eventId: federatedEvent.event_id,
                    eventType: input.eventType,
                    hasHashes: Boolean(federatedEvent.hashes?.sha256),
                    signatureServers: Object.keys(federatedEvent.signatures ?? {}),
                    authEvents: federatedEvent.auth_events?.length ?? 0,
                    prevEvents: federatedEvent.prev_events?.length ?? 0,
                  });
                  try {
                    const federationDb = isD1Database(this.appContext.capabilities.sql.connection)
                      ? this.appContext.capabilities.sql.connection
                      : undefined;
                    if (!federationDb) {
                      return;
                    }

                    await fanoutEventToRemoteServers(
                      federationDb,
                      this.appContext.capabilities.kv.cache as KVNamespace,
                      this.appContext.capabilities.config.serverName,
                      input.roomId,
                      federatedEvent,
                    );
                  } catch (error) {
                    await runClientEffect(
                      logger.error("room.command.async_error", error, {
                        command: "send_event",
                        room_id: input.roomId,
                        event_id: federatedEvent.event_id,
                        event_type: input.eventType,
                        phase: "fanout_event",
                      }),
                    );
                  }
                })(),
              );
            },
          });

          const eventId = result.persisted.eventId;
          if (typeof eventId !== "string") {
            throw new MatrixApiError("M_UNKNOWN", "Event persistence failed", 500);
          }
          await runClientEffect(
            logger.info("room.command.success", {
              command: "send_event",
              event_id: eventId,
              event_type: input.eventType,
            }),
          );
          return { event_id: eventId };
        },
      );
      return response as { event_id: string };
    } catch (error) {
      if (error instanceof DomainError) {
        throw toMatrixApiError(error);
      }
      throw error;
    }
  }

  private async executeModerationAction(input: {
    actorUserId: string;
    roomId: string;
    targetUserId: string;
    membership: "leave" | "ban";
    reason?: string;
    authorize: (context: {
      actorMembership: Awaited<ReturnType<RoomRepository["getMembership"]>>;
      targetMembership: Awaited<ReturnType<RoomRepository["getMembership"]>>;
      targetMembershipEvent: Awaited<ReturnType<RoomRepository["getStateEvent"]>>;
      actorPower: number;
      targetPower: number;
      kickPower: number;
      banPower: number;
    }) => Promise<void>;
  }): Promise<void> {
    const logger = this.createLogger("moderate_membership", {
      room_id: input.roomId,
      user_id: input.actorUserId,
    });
    await runClientEffect(
      logger.info("room.command.start", {
        command: "moderate_membership",
        membership: input.membership,
        target_user_id: input.targetUserId,
      }),
    );
    await this.eventPipeline.execute({
      input,
      validate: () => undefined,
      resolveAuth: async () => ({ userId: input.actorUserId }),
      authorize: async () => {
        const actorMembership = await this.repository.getMembership(
          input.roomId,
          input.actorUserId,
        );
        const targetMembership = await this.repository.getMembership(
          input.roomId,
          input.targetUserId,
        );
        const targetMembershipEvent = await this.repository.getStateEvent(
          input.roomId,
          "m.room.member",
          input.targetUserId,
        );
        const powerLevelsEvent = await this.repository.getStateEvent(
          input.roomId,
          "m.room.power_levels",
        );
        const powerLevels =
          (powerLevelsEvent?.content as Record<string, unknown> | undefined) ?? {};
        const users = (powerLevels["users"] as Record<string, number> | undefined) ?? {};
        const usersDefault =
          typeof powerLevels["users_default"] === "number" ? powerLevels["users_default"] : 0;

        await input.authorize({
          actorMembership,
          targetMembership,
          targetMembershipEvent,
          actorPower: users[input.actorUserId] ?? usersDefault,
          targetPower: users[input.targetUserId] ?? usersDefault,
          kickPower: typeof powerLevels["kick"] === "number" ? powerLevels["kick"] : 50,
          banPower: typeof powerLevels["ban"] === "number" ? powerLevels["ban"] : 50,
        });
      },
      buildEvent: async () => {
        const createEvent = await this.repository.getStateEvent(input.roomId, "m.room.create");
        const powerLevelsEvent = await this.repository.getStateEvent(
          input.roomId,
          "m.room.power_levels",
        );
        const actorMembership = await this.repository.getMembership(
          input.roomId,
          input.actorUserId,
        );
        const targetMembership = await this.repository.getMembership(
          input.roomId,
          input.targetUserId,
        );
        const targetMembershipEvent = await this.repository.getStateEvent(
          input.roomId,
          "m.room.member",
          input.targetUserId,
        );
        const targetMembershipContent = targetMembershipEvent?.content as
          | { membership?: unknown }
          | undefined;
        const prevContent =
          targetMembershipContent?.membership !== undefined
            ? (targetMembershipEvent?.content as Record<string, unknown>)
            : undefined;
        const prevSender = targetMembershipEvent?.sender;
        const latestEvents = await this.repository.getLatestRoomEvents(input.roomId, 1);
        const event = await createMembershipEvent({
          roomId: input.roomId,
          userId: input.targetUserId,
          sender: input.actorUserId,
          membership: input.membership,
          ...withOptionalValue("content", input.reason ? { reason: input.reason } : undefined),
          serverName: this.appContext.capabilities.config.serverName,
          generateEventId: this.appContext.capabilities.id.generateEventId,
          now: this.appContext.capabilities.clock.now,
          ...withOptionalValue("createEventId", createEvent?.event_id),
          ...withOptionalValue("powerLevelsEventId", powerLevelsEvent?.event_id),
          ...withOptionalValue(
            "currentMembershipEventId",
            targetMembership?.eventId ?? actorMembership?.eventId,
          ),
          prevEventIds: latestEvents.map((event) => event.event_id),
          depth: (latestEvents[0]?.depth ?? 0) + 1,
          ...withOptionalValue(
            "unsigned",
            prevContent
              ? {
                  prev_content: prevContent,
                  ...withOptionalValue("prev_sender", prevSender),
                }
              : undefined,
          ),
        });
        return event;
      },
      persist: async (_pipelineInput, _auth, event) => {
        await this.repository.persistMembershipEvent(input.roomId, event, "client");
        return { eventId: event.event_id };
      },
      fanout: async (_pipelineInput, _auth, event) => {
        await this.repository.notifyUsersOfEvent(input.roomId, event.event_id, "m.room.member");
      },
    });
    await runClientEffect(
      logger.info("room.command.success", {
        command: "moderate_membership",
        membership: input.membership,
        target_user_id: input.targetUserId,
      }),
    );
  }
}
