import { Effect } from "effect";
import { parseDeviceKeysPayload } from "../../../fatrix-model/types/keys-contracts";
import type { AppContext } from "../../ports/runtime/app-context";
import type { IdempotencyStore } from "../../../fetherate/runtime/idempotency";
import { checkEventAuth } from "../../../platform/cloudflare/adapters/db/event-auth";
import {
  createFederationFanoutPorts,
  fanoutEventToRemoteServersWithPorts,
} from "../../../platform/cloudflare/adapters/federation/federation-fanout";
import { sendFederationInvite } from "../../../platform/cloudflare/adapters/federation/federation-invite";
import {
  federationGet,
  federationPut,
  getServerSigningKey,
} from "../../../platform/cloudflare/adapters/federation/federation-keys";
import { getDefaultRoomVersion, getRoomVersion } from "../../../fatrix-model/room-versions";
import {
  ErrorCodes,
  type EventId,
  type PDU,
  type RoomId,
  type RoomJoinWorkflowStatus,
  type UserId,
} from "../../../fatrix-model/types";
import { isJsonObject } from "../../../fatrix-model/types/common";
import type {
  CreateRoomInput,
  InviteRoomInput,
  JoinRoomInput,
  KnockRoomInput,
  LeaveRoomInput,
  ModerateRoomInput,
  SendEventInput,
} from "../../../fatrix-model/types/rooms";
import { calculateContentHash, signJson } from "../../../fatrix-model/utils/crypto";
import { Errors, MatrixApiError } from "../../../fatrix-model/utils/errors";
import { parseUserId, toEventId, toRoomId, toUserId } from "../../../fatrix-model/utils/ids";
import type { EventPipeline } from "../domain/event-pipeline";
import type { RoomRepository } from "../../ports/repositories";
import {
  getEncryptedSharedServersForRoomService,
  getUserDevicesForRoomService,
} from "../../../platform/cloudflare/adapters/repositories/room-service-repository";
import { runClientEffect } from "../runtime/effect-runtime";
import { publishDeviceListUpdatesForNewlySharedServers } from "../features/device-lists/command";
import {
  decideInvitePermission,
  loadInvitePermissionConfig,
} from "../features/invite-permissions/policy";
import { getSharedServersInEncryptedRoomsWithUserIncludingPartialState } from "../features/partial-state/shared-servers";
import {
  buildModerationAuthorizationContext,
  buildModerationMembershipEvent,
} from "../features/rooms/policies/moderation";
import {
  getPowerLevelsContent,
  getUserPowerLevel,
} from "../features/rooms/policies/power-levels";
import {
  deriveV12RoomId,
  usesHashBasedRoomId,
} from "../features/rooms/policies/room-version-semantics";
import { sendRoomEventCommand } from "../features/rooms/commands/send-room-event";
import {
  ensureFederatedRoomStub,
  persistFederationMembershipEvent,
  persistInviteStrippedState,
} from "./federation-handler-service";
import { withLogContext, type LogContext } from "../logging";
import {
  authorizeBan,
  authorizeKick,
  authorizeLocalInvite,
  authorizeLocalJoin,
  authorizeLocalKnock,
  authorizeUnban,
  validateKnockPreconditions,
  validateLeavePreconditions,
  type JoinRulesContent,
} from "../room-membership-policy";
import {
  validateCreateRoomRequest,
  validateInviteRoomRequest,
  validateJoinRoomRequest,
  validateModerationRequest,
} from "../room-validation";
import {
  createInitialRoomEvents,
  createMembershipEvent,
  getServerFromRoomId,
} from "../rooms-support";

export type {
  CreateRoomInput,
  InviteRoomInput,
  JoinRoomInput,
  KnockRoomInput,
  LeaveRoomInput,
  ModerateRoomInput,
  SendEventInput,
};

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

function toRemoteJoinWorkflowError(status: RoomJoinWorkflowStatus): MatrixApiError {
  const output = status.output;
  const message = output?.error ?? "Failed to join remote room";
  const errorStatus = output?.errorStatus;
  const errorCode = output?.errorErrcode;

  if (errorStatus === 404 || errorCode === ErrorCodes.M_NOT_FOUND) {
    return Errors.notFound(message);
  }

  if (errorStatus === 403 || errorCode === ErrorCodes.M_FORBIDDEN) {
    return Errors.forbidden(message);
  }

  if (errorStatus === 429 || errorCode === ErrorCodes.M_LIMIT_EXCEEDED) {
    return Errors.limitExceeded(message);
  }

  if (typeof errorStatus === "number" && typeof errorCode === "string") {
    return new MatrixApiError(errorCode, message, errorStatus);
  }

  return Errors.unknown(message);
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

  const signatures = signed["signatures"] as PDU["signatures"];

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

  private getFederationDb(): D1Database | undefined {
    return isD1Database(this.appContext.capabilities.sql.connection)
      ? this.appContext.capabilities.sql.connection
      : undefined;
  }

  private getFederationCache(): KVNamespace | undefined {
    return this.appContext.capabilities.kv.cache as KVNamespace | undefined;
  }

  private async fanoutEventToFederation(
    roomId: string,
    event: PDU,
    excludeServers: string[] = [],
  ): Promise<void> {
    const db = this.getFederationDb();
    const federation = this.appContext.capabilities.federation;
    const queuePdu =
      federation?.queuePdu !== undefined
        ? (destination: string, targetRoomId: PDU["room_id"], pdu: PDU) =>
            federation.queuePdu!(destination, targetRoomId, pdu)
        : undefined;
    if (!db || !queuePdu) {
      return;
    }

    await fanoutEventToRemoteServersWithPorts(
      createFederationFanoutPorts({
        enqueuePdu: ({ destination, roomId: targetRoomId, pdu }) =>
          queuePdu(destination, targetRoomId, pdu as unknown as PDU),
      }),
      db,
      this.appContext.capabilities.config.serverName,
      roomId,
      event,
      excludeServers,
    );
  }

  private deferRoomAsyncTask(
    logger: Pick<ReturnType<MatrixRoomService["createLogger"]>, "error">,
    fields: Record<string, unknown>,
    task: () => Promise<void>,
  ): void {
    this.deferRoomAsyncPromise(logger, fields, task());
  }

  private deferRoomAsyncPromise(
    logger: Pick<ReturnType<MatrixRoomService["createLogger"]>, "error">,
    fields: Record<string, unknown>,
    task: Promise<void>,
  ): void {
    this.appContext.defer(
      task.catch((error) => {
        void runClientEffect(logger.error("room.command.async_error", error, fields));
      }),
    );
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

    const version = room_version ?? getDefaultRoomVersion();
    const serverName = this.appContext.capabilities.config.serverName;

    // For v12+ rooms (MSC4291), the room ID is derived from the hash of the
    // create event content rather than being randomly generated.
    let roomId: string;
    if (usesHashBasedRoomId(version)) {
      const createContent: Record<string, unknown> = {
        ...creation_content,
        creator: input.userId,
        room_version: version,
      };
      roomId = await deriveV12RoomId(createContent, serverName);
    } else {
      roomId = await this.appContext.capabilities.id.generateRoomId(serverName);
    }

    const typedRoomId = toRoomId(roomId);
    if (!typedRoomId) {
      throw Errors.invalidParam("room_id", "Invalid generated room ID");
    }

    const isPublic = visibility === "public";
    await this.repository.createRoom(typedRoomId, version, input.userId, isPublic);

    const createEventId = await createInitialRoomEvents(
      this.repository,
      serverName,
      typedRoomId,
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
      (targetServerName, roomVersion) =>
        this.appContext.capabilities.id.generateEventId(targetServerName, roomVersion),
      () => this.appContext.capabilities.clock.now(),
    );

    await this.repository.upsertRoomAccountData(input.userId, typedRoomId, "m.fully_read", {
      event_id: createEventId,
    });

    let roomAlias: string | undefined;
    if (roomAliasLocalPart) {
      roomAlias = this.appContext.capabilities.id.formatRoomAlias(
        roomAliasLocalPart,
        this.appContext.capabilities.config.serverName,
      );
      await this.repository.createRoomAlias(roomAlias, typedRoomId, input.userId);
    }

    await this.repository.notifyUsersOfEvent(
      typedRoomId,
      toEventId(createEventId),
      "m.room.create",
    );

    if (Array.isArray(invite)) {
      const db = this.appContext.capabilities.sql.connection as D1Database;
      const cache = this.appContext.capabilities.kv.cache as KVNamespace;
      for (const invitee of invite) {
        const inviteEvent = await this.repository.getStateEvent(
          typedRoomId,
          "m.room.member",
          invitee,
        );
        if (!inviteEvent) {
          continue;
        }
        this.deferRoomAsyncPromise(
          logger,
          {
            command: "create_room",
            room_id: roomId,
            target_user_id: invitee,
            phase: "send_federation_invite",
          },
          sendFederationInvite(
            db,
            cache,
            this.appContext.capabilities.config.serverName,
            roomId,
            inviteEvent,
          ),
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
    const preJoinSharedServers = db
      ? await getEncryptedSharedServersForRoomService(db, input.userId)
      : [];
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
      room && (isRemoteRoom ?? preferredRemoteServer) && !createEvent,
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
      const validatedRoomId = toRoomId(validated.roomId);
      if (!validatedRoomId) {
        throw Errors.invalidParam("roomId", "Invalid room ID");
      }
      const status: RoomJoinWorkflowStatus =
        await this.appContext.capabilities.workflow.createRoomJoin({
          roomId: validatedRoomId,
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

      throw toRemoteJoinWorkflowError(status);
    }

    if (!room) {
      throw Errors.notFound("Room not found");
    }

    await this.eventPipeline.execute({
      input,
      validate: () => {},
      resolveAuth: () => ({ userId: input.userId, roomVersion: room.room_version }),
      authorize: async (_pipelineInput, auth) => {
        const currentMembership = await this.repository.getMembership(
          validated.roomId,
          auth.userId,
        );
        const joinRulesEvent = await this.repository.getStateEvent(
          validated.roomId,
          "m.room.join_rules",
        );
        const joinRulesContent = (joinRulesEvent?.content ?? null) as JoinRulesContent | null;
        const repository = this.repository;
        await runClientEffect(
          authorizeLocalJoin({
            roomVersion: auth.roomVersion,
            joinRulesContent,
            currentMembership: currentMembership?.membership,
            checkAllowedRoomMembership: (allowedRoomId) =>
              Effect.promise(async () => {
                const typedAllowedRoomId = toRoomId(allowedRoomId);
                if (!typedAllowedRoomId) {
                  return false;
                }

                try {
                  const membership = await repository.getMembership(
                    typedAllowedRoomId,
                    auth.userId,
                  );
                  return membership?.membership === "join";
                } catch {
                  return false;
                }
              }),
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
          generateEventId: (targetServerName, roomVersion) =>
            this.appContext.capabilities.id.generateEventId(targetServerName, roomVersion),
          now: () => this.appContext.capabilities.clock.now(),
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
        this.deferRoomAsyncTask(
          logger,
          {
            command: "join_room",
            room_id: validated.roomId,
            event_id: event.event_id,
            phase: "fanout_join",
          },
          async () => {
            if (!db || !cache) {
              return;
            }

            await this.fanoutEventToFederation(validated.roomId, event);

            const federation = this.appContext.capabilities.federation;
            const queueEdu =
              federation?.queueEdu !== undefined
                ? (destination: string, eduType: string, content: Record<string, unknown>) =>
                    federation.queueEdu!(destination, eduType, content)
                : undefined;
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
                  getSharedServersInEncryptedRoomsWithUserIncludingPartialState(db, cache, userId),
                getUserDevices: (userId) => {
                  const typedUserId = toUserId(userId);
                  return typedUserId
                    ? getUserDevicesForRoomService(db, typedUserId)
                    : Promise.resolve([]);
                },
                getStoredDeviceKeys: (userId, deviceId) =>
                  getStoredDeviceKeysFromKv(deviceKeysKv, userId, deviceId),
                queueEdu: (destination, eduType, content) =>
                  queueEdu(destination, eduType, content),
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
          },
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

  async knockRoom(input: KnockRoomInput): Promise<{ room_id: string }> {
    const logger = this.createLogger("knock_room", {
      room_id: input.roomId,
      user_id: input.userId,
    });
    await runClientEffect(
      logger.info("room.command.start", {
        command: "knock_room",
      }),
    );

    const currentMembership = await this.repository.getMembership(input.roomId, input.userId);
    await runClientEffect(validateKnockPreconditions(currentMembership?.membership));

    const room = await this.repository.getRoom(input.roomId);
    const remoteServer = input.serverNames?.[0] ?? getServerFromRoomId(input.roomId);
    const roomCreateEvent = room
      ? await this.repository.getStateEvent(input.roomId, "m.room.create")
      : null;
    const isRemoteStubRoom = Boolean(
      room &&
      remoteServer &&
      remoteServer !== this.appContext.capabilities.config.serverName &&
      !roomCreateEvent,
    );

    if (!room || isRemoteStubRoom) {
      if (!remoteServer || remoteServer === this.appContext.capabilities.config.serverName) {
        throw Errors.notFound("Room not found");
      }

      const db = this.getFederationDb();
      const cache = this.getFederationCache();
      if (!db || !cache) {
        throw Errors.unknown("Federation runtime is not available");
      }

      const makeKnockResponse = await federationGet(
        remoteServer,
        `/_matrix/federation/v1/make_knock/${encodeURIComponent(input.roomId)}/${encodeURIComponent(input.userId)}`,
        this.appContext.capabilities.config.serverName,
        db,
        cache,
      );
      if (!makeKnockResponse.ok) {
        if (makeKnockResponse.status === 403) {
          throw Errors.forbidden("Room does not allow knocking");
        }
        if (makeKnockResponse.status === 404) {
          throw Errors.notFound("Room not found");
        }
        throw Errors.unknown(`make_knock failed: ${makeKnockResponse.status}`);
      }

      const makeKnock = await makeKnockResponse.json();
      if (!isJsonObject(makeKnock) || !isJsonObject(makeKnock.event)) {
        throw Errors.unknown("Remote server did not return a knock template");
      }

      const eventId = toEventId(
        await this.appContext.capabilities.id.generateEventId(
          this.appContext.capabilities.config.serverName,
        ),
      );
      if (!eventId) {
        throw Errors.unknown("Failed to generate a valid event ID");
      }
      const event: PDU = {
        event_id: eventId,
        room_id: input.roomId,
        sender: input.userId,
        type: "m.room.member",
        state_key: input.userId,
        content: {
          membership: "knock",
          ...(input.reason !== undefined ? { reason: input.reason } : {}),
        },
        origin_server_ts: this.appContext.capabilities.clock.now(),
        depth: typeof makeKnock.event.depth === "number" ? makeKnock.event.depth : 1,
        auth_events: Array.isArray(makeKnock.event.auth_events)
          ? makeKnock.event.auth_events.flatMap((id) => {
              const typedId = typeof id === "string" ? toEventId(id) : null;
              return typedId ? [typedId] : [];
            })
          : [],
        prev_events: Array.isArray(makeKnock.event.prev_events)
          ? makeKnock.event.prev_events.flatMap((id) => {
              const typedId = typeof id === "string" ? toEventId(id) : null;
              return typedId ? [typedId] : [];
            })
          : [],
      };

      const sendKnockResponse = await federationPut(
        remoteServer,
        `/_matrix/federation/v1/send_knock/${encodeURIComponent(input.roomId)}/${encodeURIComponent(eventId)}`,
        event,
        this.appContext.capabilities.config.serverName,
        db,
        cache,
      );
      if (!sendKnockResponse.ok) {
        throw Errors.unknown(`send_knock failed: ${sendKnockResponse.status}`);
      }

      const sendKnock = await sendKnockResponse.json();

      await ensureFederatedRoomStub(
        db,
        input.roomId,
        typeof makeKnock.room_version === "string" ? makeKnock.room_version : "10",
        "",
      );
      await persistFederationMembershipEvent(db, {
        roomId: input.roomId,
        event,
        source: "client",
      });
      await this.repository.notifyUsersOfEvent(input.roomId, eventId, "m.room.member");
      await persistInviteStrippedState(
        db,
        input.roomId,
        isJsonObject(sendKnock) && Array.isArray(sendKnock.knock_room_state)
          ? sendKnock.knock_room_state
          : [],
      );

      await runClientEffect(
        logger.info("room.command.success", {
          command: "knock_room",
          room_id: input.roomId,
          remote_server: remoteServer,
          remote: true,
        }),
      );
      return { room_id: input.roomId };
    }

    const joinRulesEvent = await this.repository.getStateEvent(input.roomId, "m.room.join_rules");
    await runClientEffect(
      authorizeLocalKnock({
        roomVersion: room.room_version,
        joinRule: (joinRulesEvent?.content as { join_rule?: string } | null)?.join_rule,
        currentMembership: currentMembership?.membership,
      }),
    );

    const eventId = toEventId(
      await this.appContext.capabilities.id.generateEventId(
        this.appContext.capabilities.config.serverName,
      ),
    );
    if (!eventId) {
      throw Errors.unknown("Failed to generate a valid event ID");
    }
    const createEvent = await this.repository.getStateEvent(input.roomId, "m.room.create");
    const powerLevelsEvent = await this.repository.getStateEvent(
      input.roomId,
      "m.room.power_levels",
    );

    const authEvents: EventId[] = [];
    if (createEvent) {
      const eventId = toEventId(createEvent.event_id);
      if (eventId) authEvents.push(eventId);
    }
    if (joinRulesEvent) {
      const eventId = toEventId(joinRulesEvent.event_id);
      if (eventId) authEvents.push(eventId);
    }
    if (powerLevelsEvent) {
      const eventId = toEventId(powerLevelsEvent.event_id);
      if (eventId) authEvents.push(eventId);
    }
    if (currentMembership) {
      const eventId = toEventId(currentMembership.eventId);
      if (eventId) authEvents.push(eventId);
    }

    const latestEvents = await this.repository.getLatestRoomEvents(input.roomId, 1);
    const prevEvents: EventId[] = latestEvents
      .map((event) => toEventId(event.event_id))
      .filter((id): id is EventId => id !== null);

    const event: PDU = {
      event_id: eventId,
      room_id: input.roomId,
      sender: input.userId,
      type: "m.room.member",
      state_key: input.userId,
      content: {
        membership: "knock",
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
      },
      origin_server_ts: this.appContext.capabilities.clock.now(),
      depth: (latestEvents[0]?.depth ?? 0) + 1,
      auth_events: authEvents,
      prev_events: prevEvents,
    };

    const roomStateForAuth: PDU[] = [];
    for (const stateEvent of [createEvent, joinRulesEvent, powerLevelsEvent]) {
      if (stateEvent) {
        roomStateForAuth.push(stateEvent);
      }
    }
    if (currentMembership) {
      const memberEvent = await this.repository.getStateEvent(
        input.roomId,
        "m.room.member",
        input.userId,
      );
      if (memberEvent) {
        roomStateForAuth.push(memberEvent);
      }
    }

    const authResult = checkEventAuth(event, roomStateForAuth, room.room_version);
    if (!authResult.allowed) {
      throw Errors.forbidden(authResult.error ?? "Event not authorized");
    }

    await this.repository.persistMembershipEvent(input.roomId, event, "client");
    await this.repository.notifyUsersOfEvent(input.roomId, eventId, "m.room.member");
    this.deferRoomAsyncTask(
      logger,
      {
        command: "knock_room",
        room_id: input.roomId,
        event_id: eventId,
        phase: "fanout_knock",
      },
      () => this.fanoutEventToFederation(input.roomId, event),
    );

    await runClientEffect(
      logger.info("room.command.success", {
        command: "knock_room",
        room_id: input.roomId,
        remote: false,
      }),
    );
    return { room_id: input.roomId };
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
      validate: () => {},
      resolveAuth: () => ({ userId: input.userId }),
      authorize: async (_pipelineInput, auth) => {
        const membership = await this.repository.getMembership(input.roomId, auth.userId);
        await runClientEffect(validateLeavePreconditions(membership?.membership));
      },
      buildEvent: async (_pipelineInput, auth) => {
        const currentMembership = await this.repository.getMembership(input.roomId, auth.userId);
        if (currentMembership?.membership === "leave") {
          return;
        }

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
          generateEventId: (targetServerName, roomVersion) =>
            this.appContext.capabilities.id.generateEventId(targetServerName, roomVersion),
          now: () => this.appContext.capabilities.clock.now(),
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
        if (!event) {
          return { alreadyLeft: true };
        }

        await this.repository.persistMembershipEvent(input.roomId, event, "client");
        return { eventId: event.event_id, alreadyLeft: false };
      },
      fanout: async (_pipelineInput, _auth, event, persisted) => {
        if (!event || persisted.alreadyLeft) {
          return;
        }

        await this.repository.notifyUsersOfEvent(input.roomId, event.event_id, "m.room.member");
        this.deferRoomAsyncTask(
          logger,
          {
            command: "leave_room",
            room_id: input.roomId,
            event_id: event.event_id,
            phase: "fanout_leave",
          },
          () => this.fanoutEventToFederation(input.roomId, event),
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
      validate: () => {},
      resolveAuth: () => ({ userId: input.userId }),
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
        const powerLevels = getPowerLevelsContent(powerLevelsEvent);
        const inviterPower = getUserPowerLevel(powerLevels, auth.userId);
        const invitePower = powerLevels.invite ?? 50;

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
          generateEventId: (targetServerName, roomVersion) =>
            this.appContext.capabilities.id.generateEventId(targetServerName, roomVersion),
          now: () => this.appContext.capabilities.clock.now(),
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
        this.deferRoomAsyncTask(
          logger,
          {
            command: "invite_room",
            room_id: validated.roomId,
            event_id: event.event_id,
            target_user_id: validated.targetUserId,
            phase: "fanout_invite",
          },
          () => this.fanoutEventToFederation(validated.roomId, event),
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

  sendEvent(input: SendEventInput): Promise<{ event_id: string }> {
    const logger = this.createLogger("send_event", {
      room_id: input.roomId,
      user_id: input.userId,
    });
    return sendRoomEventCommand(
      {
        appContext: this.appContext,
        repository: this.repository,
        eventPipeline: this.eventPipeline,
        idempotencyStore: this.idempotencyStore,
        logger,
        deferRoomAsyncTask: (targetLogger, fields, task) =>
          this.deferRoomAsyncTask(targetLogger, fields, task),
        attachFederationMetadata: (event, roomVersion) =>
          attachFederationMetadata(
            this.getFederationDb(),
            this.appContext.capabilities.config.serverName,
            event,
            roomVersion,
          ),
        fanoutEventToFederation: (roomId, event) =>
          this.fanoutEventToFederation(roomId, event),
      },
      input,
    );
  }

  private async executeModerationAction(input: {
    actorUserId: UserId;
    roomId: RoomId;
    targetUserId: UserId;
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
      validate: () => {},
      resolveAuth: () => ({ userId: input.actorUserId }),
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
        await input.authorize(
          buildModerationAuthorizationContext({
            actorUserId: input.actorUserId,
            targetUserId: input.targetUserId,
            actorMembership,
            targetMembership,
            targetMembershipEvent,
            powerLevelsEvent,
          }),
        );
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
        const latestEvents = await this.repository.getLatestRoomEvents(input.roomId, 1);
        return buildModerationMembershipEvent({
          roomId: input.roomId,
          actorUserId: input.actorUserId,
          targetUserId: input.targetUserId,
          membership: input.membership,
          ...withOptionalValue("reason", input.reason),
          serverName: this.appContext.capabilities.config.serverName,
          generateEventId: (targetServerName, roomVersion) =>
            this.appContext.capabilities.id.generateEventId(targetServerName, roomVersion),
          now: () => this.appContext.capabilities.clock.now(),
          createEvent,
          powerLevelsEvent,
          actorMembership,
          targetMembership,
          targetMembershipEvent,
          latestEvents,
        });
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
