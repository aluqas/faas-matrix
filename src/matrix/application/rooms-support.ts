import { getRoomVersion } from "../../services/room-versions";
import type { Membership, PDU, RoomCreateContent, RoomMemberContent } from "../../types";
import { calculateContentHash, calculateReferenceHashEventId } from "../../utils/crypto";
import type { RoomRepository } from "../repositories/interfaces";

export interface StateEventValidation {
  valid: boolean;
  error?: string;
}

export function validateStateEvent(event: unknown, index: number): StateEventValidation {
  if (!event || typeof event !== "object") {
    return { valid: false, error: `initial_state[${index}]: must be an object` };
  }

  const typedEvent = event as {
    type?: unknown;
    state_key?: unknown;
    content?: unknown;
  };

  if (!typedEvent.type || typeof typedEvent.type !== "string" || typedEvent.type.trim() === "") {
    return { valid: false, error: `initial_state[${index}]: missing or invalid 'type' property` };
  }

  if (typedEvent.state_key !== undefined && typeof typedEvent.state_key !== "string") {
    return { valid: false, error: `initial_state[${index}]: 'state_key' must be a string` };
  }

  if (
    !typedEvent.content ||
    typeof typedEvent.content !== "object" ||
    Array.isArray(typedEvent.content)
  ) {
    return {
      valid: false,
      error: `initial_state[${index}]: missing or invalid 'content' property`,
    };
  }

  const disallowedTypes = ["m.room.create", "m.room.member", "m.room.power_levels"];
  if (disallowedTypes.includes(typedEvent.type)) {
    return {
      valid: false,
      error: `initial_state[${index}]: '${typedEvent.type}' cannot be set via initial_state`,
    };
  }

  if (typedEvent.type === "m.room.encryption") {
    const content = typedEvent.content as { algorithm?: unknown };
    if (!content.algorithm || typeof content.algorithm !== "string") {
      return {
        valid: false,
        error: `initial_state[${index}]: m.room.encryption requires 'algorithm'`,
      };
    }
    if (content.algorithm !== "m.megolm.v1.aes-sha2") {
      return {
        valid: false,
        error: `initial_state[${index}]: unsupported algorithm '${content.algorithm}'`,
      };
    }
  }

  return { valid: true };
}

export function getServerFromRoomId(roomId: string): string | null {
  const match = roomId.match(/^![^:]+:(.+)$/);
  return match ? match[1] : null;
}

export async function createInitialRoomEvents(
  repository: RoomRepository,
  serverName: string,
  roomId: string,
  roomVersion: string,
  creatorId: string,
  options: {
    name?: string;
    topic?: string;
    preset?: string;
    is_direct?: boolean;
    initial_state?: Array<{ type: string; state_key?: string; content: Record<string, unknown> }>;
    invite?: string[];
    room_alias_local_part?: string;
  },
  generateEventId: (serverName: string, roomVersion?: string) => Promise<string>,
  now: () => number,
): Promise<string> {
  const createdAt = now();
  let depth = 0;
  const authEvents: string[] = [];
  const prevEvents: string[] = [];

  async function createEvent(
    type: string,
    content: Record<string, unknown>,
    stateKey?: string,
  ): Promise<string> {
    const baseEvent = {
      room_id: roomId,
      sender: creatorId,
      type,
      state_key: stateKey,
      content,
      origin_server_ts: createdAt,
      depth: depth++,
      auth_events: [...authEvents],
      prev_events: [...prevEvents],
    };

    const hash = await calculateContentHash(baseEvent as unknown as Record<string, unknown>);
    const eventWithHash = {
      ...baseEvent,
      hashes: { sha256: hash },
    };
    const eventId =
      (roomVersion ? getRoomVersion(roomVersion) : null)?.eventIdFormat === "v1"
        ? await generateEventId(serverName, roomVersion)
        : await calculateReferenceHashEventId(
            eventWithHash as unknown as Record<string, unknown>,
            roomVersion,
          );
    const event: PDU = {
      event_id: eventId,
      ...eventWithHash,
    };

    await repository.storeEvent(event);

    if (stateKey !== undefined) {
      authEvents.push(eventId);
    }
    prevEvents.length = 0;
    prevEvents.push(eventId);

    return eventId;
  }

  const createContent: RoomCreateContent = {
    creator: creatorId,
    room_version: roomVersion,
  };
  const createEventId = await createEvent(
    "m.room.create",
    createContent as unknown as Record<string, unknown>,
    "",
  );

  const joinContent: RoomMemberContent = {
    membership: "join",
  };
  const joinEventId = await createEvent("m.room.member", joinContent, creatorId);
  await repository.updateMembership(roomId, creatorId, "join", joinEventId);

  const preset = options.preset || "private_chat";
  await createEvent(
    "m.room.power_levels",
    {
      ban: 50,
      events: {
        "m.room.avatar": 50,
        "m.room.canonical_alias": 50,
        "m.room.encryption": 100,
        "m.room.history_visibility": 100,
        "m.room.name": 50,
        "m.room.power_levels": 100,
        "m.room.server_acl": 100,
        "m.room.tombstone": 100,
      },
      events_default: 0,
      invite: 0,
      kick: 50,
      notifications: { room: 50 },
      redact: 50,
      state_default: 50,
      users: { [creatorId]: 100 },
      users_default: 0,
    },
    "",
  );

  let joinRule = "invite";
  if (preset === "public_chat") joinRule = "public";
  await createEvent("m.room.join_rules", { join_rule: joinRule }, "");

  await createEvent("m.room.history_visibility", { history_visibility: "shared" }, "");
  await createEvent(
    "m.room.guest_access",
    { guest_access: preset === "public_chat" ? "can_join" : "forbidden" },
    "",
  );

  if (options.name) {
    await createEvent("m.room.name", { name: options.name }, "");
  }

  if (options.topic) {
    await createEvent("m.room.topic", { topic: options.topic }, "");
  }

  if (options.initial_state) {
    for (const state of options.initial_state) {
      await createEvent(state.type, state.content, state.state_key ?? "");
    }
  }

  if (options.invite) {
    for (const invitee of options.invite) {
      const inviteContent: RoomMemberContent = {
        membership: "invite",
        is_direct: options.is_direct,
      };
      const inviteEventId = await createEvent("m.room.member", inviteContent, invitee);
      await repository.updateMembership(roomId, invitee, "invite", inviteEventId);
    }
  }

  return createEventId;
}

export interface CreateMembershipEventOptions {
  roomId: string;
  userId: string;
  sender: string;
  membership: Membership;
  content?: Record<string, unknown>;
  serverName: string;
  generateEventId: (serverName: string, roomVersion?: string) => Promise<string>;
  now: () => number;
  roomVersion?: string;
  currentMembershipEventId?: string;
  joinRulesEventId?: string;
  powerLevelsEventId?: string;
  createEventId?: string;
  prevEventIds: string[];
  depth: number;
  unsigned?: Record<string, unknown>;
}

export async function createMembershipEvent(options: CreateMembershipEventOptions): Promise<PDU> {
  const authEvents: string[] = [];
  if (options.createEventId) authEvents.push(options.createEventId);
  if (options.joinRulesEventId) authEvents.push(options.joinRulesEventId);
  if (options.powerLevelsEventId) authEvents.push(options.powerLevelsEventId);
  if (options.currentMembershipEventId) authEvents.push(options.currentMembershipEventId);

  const baseEvent = {
    room_id: options.roomId,
    sender: options.sender,
    type: "m.room.member",
    state_key: options.userId,
    content: { membership: options.membership, ...options.content },
    origin_server_ts: options.now(),
    depth: options.depth,
    auth_events: authEvents,
    prev_events: options.prevEventIds,
    unsigned: options.unsigned ? options.unsigned : undefined,
  };
  const hash = await calculateContentHash(baseEvent as unknown as Record<string, unknown>);
  const eventWithHash = {
    ...baseEvent,
    hashes: { sha256: hash },
  };
  const eventId =
    (options.roomVersion ? getRoomVersion(options.roomVersion) : null)?.eventIdFormat === "v1"
      ? await options.generateEventId(options.serverName, options.roomVersion)
      : await calculateReferenceHashEventId(
          eventWithHash as unknown as Record<string, unknown>,
          options.roomVersion,
        );

  return {
    event_id: eventId,
    ...eventWithHash,
  };
}
