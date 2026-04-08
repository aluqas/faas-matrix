// Database service layer for D1

import { getUserRoomIdsWithEffectiveMembership } from "../matrix/repositories/membership-repository";
import type {
  Device,
  Env,
  EventId,
  Membership,
  PDU,
  Room,
  RoomId,
  StrippedStateEvent,
  User,
  UserId,
} from "../types";
import { toEventId, toRoomId, toUserId } from "../utils/ids";
import { fanoutEventToRemoteServers } from "./federation-fanout";
import { createFederationOutboundPort } from "./federation-outbound";

type StoredEventRow = {
  event_id: string;
  room_id: string;
  sender: string;
  event_type: string;
  state_key: string | null;
  content: string;
  origin_server_ts: number;
  unsigned: string | null;
  depth: number;
  auth_events: string;
  prev_events: string;
  event_origin?: string | null;
  event_membership?: string | null;
  prev_state?: string | null;
  hashes?: string | null;
  signatures?: string | null;
  stream_ordering?: number;
};

function parseJsonWithFallback<T>(value: string | null | undefined, fallback: T): T {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function toStoredPdu(row: StoredEventRow): PDU {
  const event_id = toEventId(row.event_id);
  const room_id = toRoomId(row.room_id);
  const sender = toUserId(row.sender);

  // These validations are critical for data integrity - database must provide valid IDs
  if (!event_id) throw new Error(`Invalid event_id format: ${row.event_id}`);
  if (!room_id) throw new Error(`Invalid room_id format: ${row.room_id}`);
  if (!sender) throw new Error(`Invalid sender format: ${row.sender}`);

  const auth_events = parseJsonWithFallback<string[]>(row.auth_events, [])
    .map((id) => toEventId(id))
    .filter((id): id is EventId => id !== null);

  const prev_events = parseJsonWithFallback<string[]>(row.prev_events, [])
    .map((id) => toEventId(id))
    .filter((id): id is EventId => id !== null);

  return {
    event_id,
    room_id,
    sender,
    type: row.event_type,
    ...withOptionalValue("origin", row.event_origin ?? undefined),
    ...withOptionalValue("membership", (row.event_membership as Membership | null) ?? undefined),
    ...(row.prev_state
      ? {
          prev_state: parseJsonWithFallback<string[]>(row.prev_state, [])
            .map((id) => toEventId(id))
            .filter((id): id is EventId => id !== null),
        }
      : {}),
    ...(row.state_key !== null ? { state_key: row.state_key } : {}),
    content: parseJsonWithFallback<Record<string, unknown>>(row.content, {}),
    origin_server_ts: row.origin_server_ts,
    ...(row.unsigned
      ? { unsigned: parseJsonWithFallback<Record<string, unknown>>(row.unsigned, {}) }
      : {}),
    depth: row.depth,
    auth_events,
    prev_events,
    ...(row.hashes ? { hashes: parseJsonWithFallback(row.hashes, { sha256: "" }) } : {}),
    ...(row.signatures
      ? {
          signatures: parseJsonWithFallback<Record<string, Record<string, string>>>(
            row.signatures,
            {},
          ),
        }
      : {}),
  };
}

function withOptionalValue<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  if (value === undefined) {
    return {};
  }

  return { [key]: value } as { [P in K]?: V };
}

type ExtractedRelation = {
  relatesToId: string;
  relationType: string;
  aggregationKey: string | null;
};

function extractEventRelation(event: PDU): ExtractedRelation | null {
  const rawContent = event.content;
  if (!rawContent || typeof rawContent !== "object" || Array.isArray(rawContent)) {
    return null;
  }

  const rawRelation = rawContent["m.relates_to"] ?? rawContent["m.relationship"];
  if (!rawRelation || typeof rawRelation !== "object" || Array.isArray(rawRelation)) {
    return null;
  }
  const relationRecord = rawRelation as Record<string, unknown>;

  const relationType =
    typeof relationRecord["rel_type"] === "string" ? relationRecord["rel_type"] : undefined;
  const relatesToId =
    typeof relationRecord["event_id"] === "string" ? relationRecord["event_id"] : undefined;
  const aggregationKey = typeof relationRecord["key"] === "string" ? relationRecord["key"] : null;

  if (!relationType || !relatesToId) {
    return null;
  }

  return {
    relatesToId,
    relationType,
    aggregationKey,
  };
}

async function persistEventRelation(db: D1Database, event: PDU): Promise<void> {
  const relation = extractEventRelation(event);
  if (!relation) {
    return;
  }

  await db
    .prepare(
      `INSERT OR REPLACE INTO event_relations (event_id, relates_to_id, relation_type, aggregation_key)
       VALUES (?, ?, ?, ?)`,
    )
    .bind(event.event_id, relation.relatesToId, relation.relationType, relation.aggregationKey)
    .run();
}

// User operations
export async function createUser(
  db: D1Database,
  userId: string,
  localpart: string,
  passwordHash: string | null,
  isGuest: boolean = false,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO users (user_id, localpart, password_hash, is_guest, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(userId, localpart, passwordHash, isGuest ? 1 : 0, Date.now(), Date.now())
    .run();
}

export async function ensureUserStub(
  db: D1Database,
  userId: string,
  localpart: string = userId,
): Promise<void> {
  const now = Date.now();
  await db
    .prepare(
      `INSERT OR IGNORE INTO users (user_id, localpart, created_at, updated_at)
     VALUES (?, ?, ?, ?)`,
    )
    .bind(userId, localpart, now, now)
    .run();
}

export async function getUserById(db: D1Database, userId: string): Promise<User | null> {
  const result = await db
    .prepare(
      `SELECT user_id, localpart, display_name, avatar_url, is_guest, is_deactivated, admin, created_at
     FROM users WHERE user_id = ?`,
    )
    .bind(userId)
    .first<{
      user_id: string;
      localpart: string;
      display_name: string | null;
      avatar_url: string | null;
      is_guest: number;
      is_deactivated: number;
      admin: number;
      created_at: number;
    }>();

  if (!result) return null;

  const user_id = toUserId(result.user_id);
  if (!user_id) throw new Error(`Invalid user_id format in database: ${result.user_id}`);

  return {
    user_id,
    localpart: result.localpart,
    ...withOptionalValue("display_name", result.display_name ?? undefined),
    ...withOptionalValue("avatar_url", result.avatar_url ?? undefined),
    is_guest: result.is_guest === 1,
    is_deactivated: result.is_deactivated === 1,
    admin: result.admin === 1,
    created_at: result.created_at,
  };
}

export async function getUserByLocalpart(db: D1Database, localpart: string): Promise<User | null> {
  const result = await db
    .prepare(
      `SELECT user_id, localpart, display_name, avatar_url, is_guest, is_deactivated, admin, created_at
     FROM users WHERE localpart = ?`,
    )
    .bind(localpart)
    .first<{
      user_id: string;
      localpart: string;
      display_name: string | null;
      avatar_url: string | null;
      is_guest: number;
      is_deactivated: number;
      admin: number;
      created_at: number;
    }>();

  if (!result) return null;

  const user_id = toUserId(result.user_id);
  if (!user_id) throw new Error(`Invalid user_id format in database: ${result.user_id}`);

  return {
    user_id,
    localpart: result.localpart,
    ...withOptionalValue("display_name", result.display_name ?? undefined),
    ...withOptionalValue("avatar_url", result.avatar_url ?? undefined),
    is_guest: result.is_guest === 1,
    is_deactivated: result.is_deactivated === 1,
    admin: result.admin === 1,
    created_at: result.created_at,
  };
}

export async function getPasswordHash(db: D1Database, userId: string): Promise<string | null> {
  const result = await db
    .prepare(`SELECT password_hash FROM users WHERE user_id = ?`)
    .bind(userId)
    .first<{ password_hash: string | null }>();

  return result?.password_hash ?? null;
}

export async function updateUserProfile(
  db: D1Database,
  userId: string,
  displayName?: string | null,
  avatarUrl?: string | null,
): Promise<void> {
  if (displayName !== undefined) {
    await db
      .prepare(`UPDATE users SET display_name = ?, updated_at = ? WHERE user_id = ?`)
      .bind(displayName, Date.now(), userId)
      .run();
  }
  if (avatarUrl !== undefined) {
    await db
      .prepare(`UPDATE users SET avatar_url = ?, updated_at = ? WHERE user_id = ?`)
      .bind(avatarUrl, Date.now(), userId)
      .run();
  }
}

// Device operations
export async function createDevice(
  db: D1Database,
  userId: string,
  deviceId: string,
  displayName?: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO devices (user_id, device_id, display_name, created_at)
     VALUES (?, ?, ?, ?)`,
    )
    .bind(userId, deviceId, displayName ?? null, Date.now())
    .run();
}

export async function getDevice(
  db: D1Database,
  userId: string,
  deviceId: string,
): Promise<Device | null> {
  const result = await db
    .prepare(
      `SELECT device_id, user_id, display_name, last_seen_ts, last_seen_ip, created_at
     FROM devices WHERE user_id = ? AND device_id = ?`,
    )
    .bind(userId, deviceId)
    .first<{
      device_id: string;
      user_id: string;
      display_name: string | null;
      last_seen_ts: number | null;
      last_seen_ip: string | null;
      created_at: number;
    }>();

  if (!result) return null;

  const user_id = toUserId(result.user_id);
  if (!user_id) throw new Error(`Invalid user_id format in database: ${result.user_id}`);

  return {
    device_id: result.device_id,
    user_id,
    ...withOptionalValue("display_name", result.display_name ?? undefined),
    ...withOptionalValue("last_seen_ts", result.last_seen_ts ?? undefined),
    ...withOptionalValue("last_seen_ip", result.last_seen_ip ?? undefined),
  };
}

export async function getUserDevices(db: D1Database, userId: string): Promise<Device[]> {
  const result = await db
    .prepare(
      `SELECT device_id, user_id, display_name, last_seen_ts, last_seen_ip
     FROM devices WHERE user_id = ?`,
    )
    .bind(userId)
    .all<{
      device_id: string;
      user_id: string;
      display_name: string | null;
      last_seen_ts: number | null;
      last_seen_ip: string | null;
    }>();

  return result.results
    .map((r) => {
      const typedUserId = toUserId(r.user_id);
      if (!typedUserId) {
        throw new Error(`Invalid user_id format in database: ${r.user_id}`);
      }

      return {
        device_id: r.device_id,
        user_id: typedUserId,
        ...withOptionalValue("display_name", r.display_name ?? undefined),
        ...withOptionalValue("last_seen_ts", r.last_seen_ts ?? undefined),
        ...withOptionalValue("last_seen_ip", r.last_seen_ip ?? undefined),
      };
    })
    .filter((device): device is Device => device.user_id !== undefined);
}

const LOCAL_NOTIFICATION_SETTINGS_PREFIX = "org.matrix.msc3890.local_notification_settings.";

async function recordAccountDataChange(
  db: D1Database,
  userId: string,
  roomId: string,
  eventType: string,
): Promise<void> {
  const pos = await db
    .prepare(`
    SELECT MAX(pos) as next_pos FROM (
      SELECT COALESCE(MAX(stream_ordering), 0) as pos FROM events
      UNION ALL
      SELECT COALESCE(MAX(stream_position), 0) as pos FROM account_data_changes
    )
  `)
    .first<{ next_pos: number }>();
  const streamPosition = (pos?.next_pos ?? 0) + 1;

  await db
    .prepare(`
    INSERT INTO account_data_changes (user_id, room_id, event_type, stream_position)
    VALUES (?, ?, ?, ?)
  `)
    .bind(userId, roomId, eventType, streamPosition)
    .run();
}

async function markGlobalAccountDataDeleted(
  db: D1Database,
  userId: string,
  eventType: string,
): Promise<void> {
  await db
    .prepare(`
    INSERT INTO account_data (user_id, room_id, event_type, content, deleted)
    VALUES (?, '', ?, '{}', 1)
    ON CONFLICT (user_id, room_id, event_type) DO UPDATE SET content = '{}', deleted = 1
  `)
    .bind(userId, eventType)
    .run();
  await recordAccountDataChange(db, userId, "", eventType);
}

async function deleteDeviceLocalNotificationSettings(
  db: D1Database,
  userId: string,
  deviceId: string,
): Promise<void> {
  await markGlobalAccountDataDeleted(
    db,
    userId,
    `${LOCAL_NOTIFICATION_SETTINGS_PREFIX}${deviceId}`,
  );
}

export async function deleteDevice(
  db: D1Database,
  userId: string,
  deviceId: string,
): Promise<void> {
  await deleteDeviceLocalNotificationSettings(db, userId, deviceId);
  await db
    .prepare(`DELETE FROM devices WHERE user_id = ? AND device_id = ?`)
    .bind(userId, deviceId)
    .run();
}

export async function deleteAllUserDevices(db: D1Database, userId: string): Promise<void> {
  const notificationSettings = await db
    .prepare(`
      SELECT event_type
      FROM account_data
      WHERE user_id = ? AND room_id = '' AND event_type LIKE ? AND deleted = 0
    `)
    .bind(userId, `${LOCAL_NOTIFICATION_SETTINGS_PREFIX}%`)
    .all<{ event_type: string }>();

  for (const setting of notificationSettings.results) {
    await markGlobalAccountDataDeleted(db, userId, setting.event_type);
  }

  await db.prepare(`DELETE FROM devices WHERE user_id = ?`).bind(userId).run();
}

export async function deleteOtherUserDevices(
  db: D1Database,
  userId: string,
  keepDeviceId: string,
): Promise<void> {
  const devices = await db
    .prepare(`
      SELECT device_id
      FROM devices
      WHERE user_id = ? AND device_id != ?
    `)
    .bind(userId, keepDeviceId)
    .all<{ device_id: string }>();

  for (const device of devices.results) {
    await deleteDevice(db, userId, device.device_id);
  }
}

// Access token operations
export async function createAccessToken(
  db: D1Database,
  tokenId: string,
  tokenHash: string,
  userId: string,
  deviceId: string | null,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO access_tokens (token_id, token_hash, user_id, device_id, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(tokenId, tokenHash, userId, deviceId, Date.now())
    .run();
}

export async function getUserByTokenHash(
  db: D1Database,
  tokenHash: string,
): Promise<{ userId: UserId; deviceId: string | null } | null> {
  const result = await db
    .prepare(`SELECT user_id, device_id FROM access_tokens WHERE token_hash = ?`)
    .bind(tokenHash)
    .first<{ user_id: string; device_id: string | null }>();

  if (!result) return null;

  const userId = toUserId(result.user_id);
  if (!userId) throw new Error(`Invalid user_id format in database: ${result.user_id}`);

  return {
    userId,
    deviceId: result.device_id,
  };
}

export async function getAccessTokenRecordByHash(
  db: D1Database,
  tokenHash: string,
): Promise<{ tokenId: string; userId: UserId; deviceId: string | null } | null> {
  const result = await db
    .prepare(`SELECT token_id, user_id, device_id FROM access_tokens WHERE token_hash = ?`)
    .bind(tokenHash)
    .first<{ token_id: string; user_id: string; device_id: string | null }>();

  if (!result) return null;

  const userId = toUserId(result.user_id);
  if (!userId) throw new Error(`Invalid user_id format in database: ${result.user_id}`);

  return {
    tokenId: result.token_id,
    userId,
    deviceId: result.device_id,
  };
}

export async function deleteAccessToken(db: D1Database, tokenHash: string): Promise<void> {
  await db.prepare(`DELETE FROM access_tokens WHERE token_hash = ?`).bind(tokenHash).run();
}

export async function deleteAllUserTokens(db: D1Database, userId: string): Promise<void> {
  await db.prepare(`DELETE FROM access_tokens WHERE user_id = ?`).bind(userId).run();
}

// Room operations
export async function createRoom(
  db: D1Database,
  roomId: string,
  roomVersion: string,
  creatorId: string,
  isPublic: boolean = false,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO rooms (room_id, room_version, creator_id, is_public, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(roomId, roomVersion, creatorId, isPublic ? 1 : 0, Date.now())
    .run();
}

export async function getRoom(db: D1Database, roomId: string): Promise<Room | null> {
  const result = await db
    .prepare(
      `SELECT room_id, room_version, is_public, creator_id, created_at
     FROM rooms WHERE room_id = ?`,
    )
    .bind(roomId)
    .first<{
      room_id: string;
      room_version: string;
      is_public: number;
      creator_id: string | null;
      created_at: number;
    }>();

  if (!result) return null;

  const room_id = toRoomId(result.room_id);
  if (!room_id) throw new Error(`Invalid room_id format in database: ${result.room_id}`);

  const creator_id = result.creator_id ? toUserId(result.creator_id) : undefined;
  if (result.creator_id && !creator_id) {
    throw new Error(`Invalid creator_id format in database: ${result.creator_id}`);
  }

  return {
    room_id,
    room_version: result.room_version,
    is_public: result.is_public === 1,
    ...withOptionalValue("creator_id", creator_id),
    created_at: result.created_at,
  } as Room;
}

// Event operations
export async function storeEvent(
  db: D1Database,
  event: PDU,
  options?: { skipRoomState?: boolean },
): Promise<number> {
  const skipRoomState = options?.skipRoomState ?? false;
  const existing = await db
    .prepare(`SELECT stream_ordering FROM events WHERE event_id = ?`)
    .bind(event.event_id)
    .first<{ stream_ordering: number }>();
  if (existing) {
    await persistEventRelation(db, event);

    if (!skipRoomState && event.state_key !== undefined) {
      await db
        .prepare(
          `INSERT OR REPLACE INTO room_state (room_id, event_type, state_key, event_id)
         VALUES (?, ?, ?, ?)`,
        )
        .bind(event.room_id, event.type, event.state_key, event.event_id)
        .run();
    }
    return existing.stream_ordering;
  }

  // Get the next stream ordering
  const lastOrdering = await db
    .prepare(`SELECT MAX(stream_ordering) as max_ordering FROM events`)
    .first<{ max_ordering: number | null }>();

  const streamOrdering = (lastOrdering?.max_ordering ?? 0) + 1;

  await db
    .prepare(
      `INSERT OR IGNORE INTO events (event_id, room_id, sender, event_type, state_key, content,
     origin_server_ts, unsigned, depth, auth_events, prev_events, event_origin, event_membership,
     prev_state, hashes, signatures, stream_ordering)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      event.event_id,
      event.room_id,
      event.sender,
      event.type,
      event.state_key ?? null,
      JSON.stringify(event.content),
      event.origin_server_ts,
      event.unsigned ? JSON.stringify(event.unsigned) : null,
      event.depth,
      JSON.stringify(event.auth_events),
      JSON.stringify(event.prev_events),
      event.origin ?? null,
      event.membership ?? null,
      event.prev_state ? JSON.stringify(event.prev_state) : null,
      event.hashes ? JSON.stringify(event.hashes) : null,
      event.signatures ? JSON.stringify(event.signatures) : null,
      streamOrdering,
    )
    .run();

  await persistEventRelation(db, event);

  // Update room state if this is a state event (skip for historical/auth-chain events)
  if (!skipRoomState && event.state_key !== undefined) {
    await db
      .prepare(
        `INSERT OR REPLACE INTO room_state (room_id, event_type, state_key, event_id)
       VALUES (?, ?, ?, ?)`,
      )
      .bind(event.room_id, event.type, event.state_key, event.event_id)
      .run();
  }

  return streamOrdering;
}

export async function getEvent(db: D1Database, eventId: string): Promise<PDU | null> {
  const result = await db
    .prepare(
      `SELECT event_id, room_id, sender, event_type, state_key, content,
     origin_server_ts, unsigned, depth, auth_events, prev_events, event_origin, event_membership,
     prev_state, hashes, signatures
     FROM events WHERE event_id = ?`,
    )
    .bind(eventId)
    .first<StoredEventRow>();

  if (!result) return null;

  return toStoredPdu(result);
}

export async function getRoomEvents(
  db: D1Database,
  roomId: string,
  fromToken?: number,
  limit: number = 50,
  direction: "f" | "b" = "b",
  relationFilter?: {
    relTypes?: string[];
    notRelTypes?: string[];
  },
): Promise<{ events: PDU[]; end: number }> {
  let query: string;
  const params: (string | number)[] = [roomId];
  const hasRelationFilter =
    (relationFilter?.relTypes?.length ?? 0) > 0 || (relationFilter?.notRelTypes?.length ?? 0) > 0;
  const relationJoin = hasRelationFilter
    ? " LEFT JOIN event_relations r ON r.event_id = e.event_id"
    : "";
  const whereClauses = ["e.room_id = ?"];

  if ((relationFilter?.relTypes?.length ?? 0) > 0) {
    whereClauses.push(
      `r.relation_type IN (${relationFilter!.relTypes!.map(() => "?").join(", ")})`,
    );
    params.push(...relationFilter!.relTypes!);
  }

  if ((relationFilter?.notRelTypes?.length ?? 0) > 0) {
    whereClauses.push(
      `(r.relation_type IS NULL OR r.relation_type NOT IN (${relationFilter!.notRelTypes!.map(() => "?").join(", ")}))`,
    );
    params.push(...relationFilter!.notRelTypes!);
  }

  if (direction === "b") {
    // Backwards (newest first)
    if (fromToken !== undefined) {
      whereClauses.push("e.stream_ordering < ?");
      query = `SELECT DISTINCT e.* FROM events e${relationJoin} WHERE ${whereClauses.join(" AND ")} ORDER BY e.stream_ordering DESC LIMIT ?`;
      params.push(fromToken, limit);
    } else {
      query = `SELECT DISTINCT e.* FROM events e${relationJoin} WHERE ${whereClauses.join(" AND ")} ORDER BY e.stream_ordering DESC LIMIT ?`;
      params.push(limit);
    }
  } else {
    // Forwards (oldest first)
    if (fromToken !== undefined) {
      whereClauses.push("e.stream_ordering > ?");
      query = `SELECT DISTINCT e.* FROM events e${relationJoin} WHERE ${whereClauses.join(" AND ")} ORDER BY e.stream_ordering ASC LIMIT ?`;
      params.push(fromToken, limit);
    } else {
      query = `SELECT DISTINCT e.* FROM events e${relationJoin} WHERE ${whereClauses.join(" AND ")} ORDER BY e.stream_ordering ASC LIMIT ?`;
      params.push(limit);
    }
  }

  const result = await db
    .prepare(query)
    .bind(...params)
    .all<StoredEventRow>();

  const events = result.results.map(toStoredPdu);

  const lastEvent = result.results.at(-1);
  const end = lastEvent?.stream_ordering ?? fromToken ?? 0;

  return { events, end };
}

// Room state operations
export async function getRoomState(db: D1Database, roomId: string): Promise<PDU[]> {
  const result = await db
    .prepare(
      `SELECT e.event_id, e.room_id, e.sender, e.event_type, e.state_key, e.content,
     e.origin_server_ts, e.unsigned, e.depth, e.auth_events, e.prev_events, e.event_origin,
     e.event_membership, e.prev_state, e.hashes, e.signatures
     FROM room_state rs
     JOIN events e ON rs.event_id = e.event_id
     WHERE rs.room_id = ?`,
    )
    .bind(roomId)
    .all<StoredEventRow>();

  const events = result.results.map(toStoredPdu);

  if (!events.some((event) => event.type === "m.room.create")) {
    const createEvent = await db
      .prepare(
        `SELECT event_id, room_id, sender, event_type, state_key, content,
       origin_server_ts, unsigned, depth, auth_events, prev_events, event_origin,
       event_membership, prev_state, hashes, signatures
       FROM events
       WHERE room_id = ? AND event_type = 'm.room.create'
       LIMIT 1`,
      )
      .bind(roomId)
      .first<StoredEventRow>();

    if (createEvent) {
      events.push(toStoredPdu(createEvent));
    }
  }

  return events;
}

export async function getStateEvent(
  db: D1Database,
  roomId: string,
  eventType: string,
  stateKey: string = "",
): Promise<PDU | null> {
  const result = await db
    .prepare(
      `SELECT e.event_id, e.room_id, e.sender, e.event_type, e.state_key, e.content,
     e.origin_server_ts, e.unsigned, e.depth, e.auth_events, e.prev_events, e.event_origin,
     e.event_membership, e.prev_state, e.hashes, e.signatures
     FROM room_state rs
     JOIN events e ON rs.event_id = e.event_id
     WHERE rs.room_id = ? AND rs.event_type = ? AND rs.state_key = ?`,
    )
    .bind(roomId, eventType, stateKey)
    .first<StoredEventRow>();

  if (!result && eventType === "m.room.create" && stateKey === "") {
    const createEvent = await db
      .prepare(
        `SELECT event_id, room_id, sender, event_type, state_key, content,
       origin_server_ts, unsigned, depth, auth_events, prev_events, event_origin,
       event_membership, prev_state, hashes, signatures
       FROM events
       WHERE room_id = ? AND event_type = 'm.room.create'
       LIMIT 1`,
      )
      .bind(roomId)
      .first<StoredEventRow>();

    if (createEvent) {
      return toStoredPdu(createEvent);
    }
  }

  if (!result) return null;

  return toStoredPdu(result);
}

// Membership operations
export async function updateMembership(
  db: D1Database,
  roomId: string,
  userId: string,
  membership: Membership,
  eventId: string,
  displayName?: string,
  avatarUrl?: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT OR REPLACE INTO room_memberships (room_id, user_id, membership, event_id, display_name, avatar_url)
     VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(roomId, userId, membership, eventId, displayName ?? null, avatarUrl ?? null)
    .run();

  if (membership !== "invite") {
    const remainingInvites = await db
      .prepare(
        `SELECT COUNT(*) AS count FROM room_memberships WHERE room_id = ? AND membership = 'invite'`,
      )
      .bind(roomId)
      .first<{ count: number | string }>();

    const count = Number(remainingInvites?.count ?? 0);
    if (count === 0) {
      await db.prepare(`DELETE FROM invite_stripped_state WHERE room_id = ?`).bind(roomId).run();
    }
  }
}

export async function getMembership(
  db: D1Database,
  roomId: string,
  userId: string,
): Promise<{ membership: Membership; eventId: string; streamOrdering?: number } | null> {
  const result = await db
    .prepare(
      `
      WITH membership_sources AS (
        SELECT rm.membership, rm.event_id, e.stream_ordering, 1 AS precedence
        FROM room_memberships rm
        LEFT JOIN events e ON e.event_id = rm.event_id
        WHERE rm.room_id = ? AND rm.user_id = ?

        UNION ALL

        SELECT
          json_extract(e.content, '$.membership') AS membership,
          rs.event_id AS event_id,
          e.stream_ordering AS stream_ordering,
          2 AS precedence
        FROM room_state rs
        JOIN events e ON rs.event_id = e.event_id
        WHERE rs.room_id = ?
          AND rs.event_type = 'm.room.member'
          AND rs.state_key = ?
          AND NOT EXISTS (
            SELECT 1
            FROM room_memberships rm
            WHERE rm.room_id = rs.room_id
              AND rm.user_id = rs.state_key
          )
      )
      SELECT membership, event_id, stream_ordering
      FROM membership_sources
      WHERE membership IN ('join', 'invite', 'leave', 'ban', 'knock')
      ORDER BY precedence
      LIMIT 1
    `,
    )
    .bind(roomId, userId, roomId, userId)
    .first<{ membership: Membership; event_id: string; stream_ordering: number | null }>();

  if (!result) return null;

  return {
    membership: result.membership,
    eventId: result.event_id,
    ...(result.stream_ordering !== null ? { streamOrdering: result.stream_ordering } : {}),
  };
}

export async function getInviteStrippedState(
  db: D1Database,
  roomId: string,
): Promise<StrippedStateEvent[]> {
  const result = await db
    .prepare(
      `SELECT event_type, state_key, content, sender FROM invite_stripped_state WHERE room_id = ?`,
    )
    .bind(roomId)
    .all<{ event_type: string; state_key: string; content: string; sender: string }>();
  return result.results.map((r) => {
    const sender = toUserId(r.sender);
    if (!sender) {
      throw new Error(`Invalid sender format in database: ${r.sender}`);
    }

    return {
      type: r.event_type,
      state_key: r.state_key,
      content: parseJsonWithFallback<Record<string, unknown>>(r.content, {}),
      sender,
    };
  });
}

/**
 * Returns room IDs for the given user, optionally filtered by membership.
 * Delegates to [`getUserRoomIdsWithEffectiveMembership`](../matrix/repositories/membership-repository.ts).
 */
export function getUserRooms(
  db: D1Database,
  userId: string,
  membership?: Membership,
): Promise<RoomId[]> {
  return getUserRoomIdsWithEffectiveMembership(db, userId, membership);
}

export async function getRoomMembers(
  db: D1Database,
  roomId: string,
  membership?: Membership,
): Promise<
  Array<{ userId: string; membership: Membership; displayName?: string; avatarUrl?: string }>
> {
  let query = `
    WITH latest_membership_events AS (
      SELECT
        e.room_id,
        e.state_key AS user_id,
        json_extract(e.content, '$.membership') AS membership,
        json_extract(e.content, '$.displayname') AS display_name,
        json_extract(e.content, '$.avatar_url') AS avatar_url
      FROM events e
      WHERE e.room_id = ?
        AND e.event_type = 'm.room.member'
        AND e.state_key IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM room_memberships rm
          WHERE rm.room_id = e.room_id
            AND rm.user_id = e.state_key
        )
        AND NOT EXISTS (
          SELECT 1
          FROM events newer
          WHERE newer.room_id = e.room_id
            AND newer.event_type = 'm.room.member'
            AND newer.state_key = e.state_key
            AND (
              newer.depth > e.depth
              OR (
                newer.depth = e.depth
                AND newer.origin_server_ts > e.origin_server_ts
              )
              OR (
                newer.depth = e.depth
                AND newer.origin_server_ts = e.origin_server_ts
                AND newer.event_id > e.event_id
              )
            )
        )
    ),
    current_memberships AS (
      SELECT room_id, user_id, membership, display_name, avatar_url
      FROM room_memberships
      WHERE room_id = ?

      UNION

      SELECT room_id, user_id, membership, display_name, avatar_url
      FROM latest_membership_events
    )
    SELECT user_id, membership, display_name, avatar_url
    FROM current_memberships
    WHERE room_id = ?
  `;
  const params: string[] = [roomId, roomId, roomId];

  if (membership) {
    query += ` AND membership = ?`;
    params.push(membership);
  }

  const result = await db
    .prepare(query)
    .bind(...params)
    .all<{
      user_id: string;
      membership: Membership;
      display_name: string | null;
      avatar_url: string | null;
    }>();

  return result.results.map((r) => ({
    userId: r.user_id,
    membership: r.membership,
    ...withOptionalValue("displayName", r.display_name ?? undefined),
    ...withOptionalValue("avatarUrl", r.avatar_url ?? undefined),
  }));
}

// Room alias operations
export async function createRoomAlias(
  db: D1Database,
  alias: string,
  roomId: string,
  creatorId: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO room_aliases (alias, room_id, creator_id, created_at)
     VALUES (?, ?, ?, ?)`,
    )
    .bind(alias, roomId, creatorId, Date.now())
    .run();
}

export async function getRoomByAlias(db: D1Database, alias: string): Promise<string | null> {
  const result = await db
    .prepare(`SELECT room_id FROM room_aliases WHERE alias = ?`)
    .bind(alias)
    .first<{ room_id: string }>();

  return result?.room_id ?? null;
}

export async function deleteRoomAlias(db: D1Database, alias: string): Promise<void> {
  await db.prepare(`DELETE FROM room_aliases WHERE alias = ?`).bind(alias).run();
}

// Stream position for sync
export async function getLatestStreamPosition(db: D1Database): Promise<number> {
  const result = await db
    .prepare(`
    SELECT MAX(pos) as max_pos FROM (
      SELECT COALESCE(MAX(stream_ordering), 0) as pos FROM events
      UNION ALL
      SELECT COALESCE(MAX(stream_position), 0) as pos FROM account_data_changes
    )
  `)
    .first<{ max_pos: number | null }>();

  return result?.max_pos ?? 0;
}

export async function getEventsSince(
  db: D1Database,
  roomId: string,
  since: number,
  limit: number = 100,
): Promise<PDU[]> {
  const query =
    since > 0
      ? `SELECT event_id, room_id, sender, event_type, state_key, content,
       origin_server_ts, unsigned, depth, auth_events, prev_events, event_origin, event_membership,
       prev_state, hashes, signatures
       FROM events
       WHERE room_id = ? AND stream_ordering > ?
       ORDER BY stream_ordering ASC
       LIMIT ?`
      : `SELECT event_id, room_id, sender, event_type, state_key, content,
       origin_server_ts, unsigned, depth, auth_events, prev_events, event_origin, event_membership,
       prev_state, hashes, signatures
       FROM events
       WHERE room_id = ? AND stream_ordering > 0
       ORDER BY stream_ordering DESC
       LIMIT ?`;

  const statement = db.prepare(query);
  const result =
    since > 0
      ? await statement.bind(roomId, since, limit).all<StoredEventRow>()
      : await statement.bind(roomId, limit).all<StoredEventRow>();

  const rows = since > 0 ? result.results : [...result.results].toReversed();
  return rows.map(toStoredPdu);
}

export async function getLatestRoomEventsByDepth(
  db: D1Database,
  roomId: string,
  limit: number = 1,
): Promise<PDU[]> {
  const result = await db
    .prepare(
      `SELECT event_id, room_id, sender, event_type, state_key, content,
       origin_server_ts, unsigned, depth, auth_events, prev_events, event_origin, event_membership,
       prev_state, hashes, signatures
       FROM events
       WHERE room_id = ?
       ORDER BY depth DESC, stream_ordering DESC
       LIMIT ?`,
    )
    .bind(roomId, limit)
    .all<StoredEventRow>();

  return result.results.map(toStoredPdu);
}

export async function getLatestForwardExtremities(
  db: D1Database,
  roomId: string,
  limit: number = 1,
): Promise<PDU[]> {
  const result = await db
    .prepare(
      `SELECT e.event_id, e.room_id, e.sender, e.event_type, e.state_key, e.content,
       e.origin_server_ts, e.unsigned, e.depth, e.auth_events, e.prev_events, e.event_origin,
       e.event_membership, e.prev_state, e.hashes, e.signatures
       FROM events e
       WHERE e.room_id = ?
         AND NOT EXISTS (
           SELECT 1
           FROM events child, json_each(child.prev_events) prev
           WHERE child.room_id = e.room_id
             AND prev.value = e.event_id
         )
       ORDER BY e.stream_ordering DESC, e.depth DESC
       LIMIT ?`,
    )
    .bind(roomId, limit)
    .all<StoredEventRow>();

  return result.results.map(toStoredPdu);
}

// Batch retrieve events by IDs
export async function getEventsByIds(db: D1Database, eventIds: string[]): Promise<PDU[]> {
  if (eventIds.length === 0) return [];

  // D1 doesn't support array binding, so we batch with placeholders
  const placeholders = eventIds.map(() => "?").join(", ");
  const result = await db
    .prepare(
      `SELECT event_id, room_id, sender, event_type, state_key, content,
     origin_server_ts, unsigned, depth, auth_events, prev_events, event_origin, event_membership,
     prev_state, hashes, signatures
     FROM events WHERE event_id IN (${placeholders})`,
    )
    .bind(...eventIds)
    .all<StoredEventRow>();

  return result.results.map(toStoredPdu);
}

const DEFERRED_AUTH_MARKER_SEARCH_PATTERN = `%"io.tuwunel.partial_state_auth_deferred"%`;

export async function getDeferredPartialStateAuthEventsForRoom(
  db: D1Database,
  roomId: string,
): Promise<PDU[]> {
  const result = await db
    .prepare(
      `SELECT event_id, room_id, sender, event_type, state_key, content,
       origin_server_ts, unsigned, depth, auth_events, prev_events, event_origin, event_membership,
       prev_state, hashes, signatures
       FROM events
       WHERE room_id = ? AND unsigned LIKE ?`,
    )
    .bind(roomId, DEFERRED_AUTH_MARKER_SEARCH_PATTERN)
    .all<StoredEventRow>();

  return result.results.map(toStoredPdu);
}

export async function rejectProcessedPdu(
  db: D1Database,
  eventId: string,
  reason: string,
): Promise<void> {
  await db
    .prepare(`UPDATE processed_pdus SET accepted = 0, rejection_reason = ? WHERE event_id = ?`)
    .bind(reason, eventId)
    .run();
}

export async function clearDeferredAuthMarkerForEvent(
  db: D1Database,
  eventId: string,
): Promise<void> {
  const row = await db
    .prepare(`SELECT unsigned FROM events WHERE event_id = ?`)
    .bind(eventId)
    .first<{ unsigned: string | null }>();

  if (!row?.unsigned) return;

  let unsignedObj: Record<string, unknown>;
  try {
    unsignedObj = JSON.parse(row.unsigned) as Record<string, unknown>;
  } catch {
    return;
  }

  delete unsignedObj["io.tuwunel.partial_state_auth_deferred"];
  delete unsignedObj["io.tuwunel.partial_state_auth_deferred_previous_event_id"];
  delete unsignedObj["io.tuwunel.partial_state_auth_deferred_previous_membership"];

  const newUnsigned = Object.keys(unsignedObj).length > 0 ? JSON.stringify(unsignedObj) : null;
  await db
    .prepare(`UPDATE events SET unsigned = ? WHERE event_id = ?`)
    .bind(newUnsigned, eventId)
    .run();
}

export async function setRoomStateEvent(
  db: D1Database,
  roomId: string,
  eventType: string,
  stateKey: string,
  eventId: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT OR REPLACE INTO room_state (room_id, event_type, state_key, event_id)
       VALUES (?, ?, ?, ?)`,
    )
    .bind(roomId, eventType, stateKey, eventId)
    .run();
}

export async function deleteRoomStateEvent(
  db: D1Database,
  roomId: string,
  eventType: string,
  stateKey: string,
): Promise<void> {
  await db
    .prepare(`DELETE FROM room_state WHERE room_id = ? AND event_type = ? AND state_key = ?`)
    .bind(roomId, eventType, stateKey)
    .run();
}

// Get the auth chain for an event (all auth_events recursively)
export async function getAuthChain(db: D1Database, eventIds: string[]): Promise<PDU[]> {
  const seen = new Set<string>();
  const chain: PDU[] = [];
  const queue = [...eventIds];

  while (queue.length > 0) {
    const batch = queue.splice(0, 50).filter((id) => !seen.has(id));
    if (batch.length === 0) continue;

    for (const id of batch) seen.add(id);

    const events = await getEventsByIds(db, batch);
    for (const event of events) {
      chain.push(event);
      for (const authId of event.auth_events) {
        if (!seen.has(authId)) {
          queue.push(authId);
        }
      }
    }
  }

  return chain;
}

// Get the state at a specific event (by traversing auth chain)
export async function getStateAtEvent(db: D1Database, eventId: string): Promise<PDU[]> {
  const event = await getEvent(db, eventId);
  if (!event) return [];

  // Get the auth chain for this event's auth_events
  const authEvents = await getEventsByIds(db, event.auth_events);

  // Build current state from auth events
  const stateMap = new Map<string, PDU>();
  for (const authEvent of authEvents) {
    if (authEvent.state_key !== undefined) {
      stateMap.set(`${authEvent.type}\0${authEvent.state_key}`, authEvent);
    }
  }

  return Array.from(stateMap.values());
}

// Get servers that share rooms with a user
export function getServersInRoomsWithUser(db: D1Database, userId: string): Promise<string[]> {
  return getServersInRoomsWithUserExcludingRooms(db, userId, []);
}

async function getServersInRoomsWithUserScope(
  db: D1Database,
  userId: string,
  excludedRoomIds: string[],
  options?: { encryptedOnly?: boolean },
): Promise<string[]> {
  const exclusionClause =
    excludedRoomIds.length > 0
      ? ` AND room_id NOT IN (${excludedRoomIds.map(() => "?").join(", ")})`
      : "";
  const roomScope = options?.encryptedOnly ? "encrypted_joined_rooms" : "joined_rooms";
  const result = await db
    .prepare(`
    WITH current_memberships AS (
      SELECT room_id, user_id, membership
      FROM room_memberships

      UNION

      SELECT
        rs.room_id,
        rs.state_key AS user_id,
        json_extract(e.content, '$.membership') AS membership
      FROM room_state rs
      JOIN events e ON rs.event_id = e.event_id
      WHERE rs.event_type = 'm.room.member'
        AND rs.state_key IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM room_memberships rm
          WHERE rm.room_id = rs.room_id
            AND rm.user_id = rs.state_key
        )
    ),
    joined_rooms AS (
      SELECT room_id
      FROM current_memberships
      WHERE user_id = ? AND membership = 'join'
      ${exclusionClause}
    ),
    encrypted_joined_rooms AS (
      SELECT jr.room_id
      FROM joined_rooms jr
      WHERE EXISTS (
        SELECT 1
        FROM room_state rs
        WHERE rs.room_id = jr.room_id
          AND rs.event_type = 'm.room.encryption'
      )
    ),
    joined_members AS (
      SELECT room_id, user_id
      FROM current_memberships
      WHERE membership = 'join'
    )
    SELECT DISTINCT
      CASE
        WHEN INSTR(jm.user_id, ':') > 0 THEN SUBSTR(jm.user_id, INSTR(jm.user_id, ':') + 1)
        ELSE NULL
      END AS server_name
    FROM ${roomScope} jr
    JOIN joined_members jm ON jr.room_id = jm.room_id
    WHERE jm.user_id != ?
  `)
    .bind(userId, ...excludedRoomIds, userId)
    .all<{ server_name: string | null }>();

  return result.results.map((r) => r.server_name).filter((s): s is string => s !== null);
}

export function getServersInRoomsWithUserExcludingRooms(
  db: D1Database,
  userId: string,
  excludedRoomIds: string[],
): Promise<string[]> {
  return getServersInRoomsWithUserScope(db, userId, excludedRoomIds);
}

export function getServersInEncryptedRoomsWithUser(
  db: D1Database,
  userId: string,
): Promise<string[]> {
  return getServersInRoomsWithUserScope(db, userId, [], { encryptedOnly: true });
}

export function getServersInEncryptedRoomsWithUserExcludingRooms(
  db: D1Database,
  userId: string,
  excludedRoomIds: string[],
): Promise<string[]> {
  return getServersInRoomsWithUserScope(db, userId, excludedRoomIds, { encryptedOnly: true });
}

// Notify all room members' SyncDurableObjects when a new event is stored
// This wakes up long-polling sync requests waiting for events
export async function notifyUsersOfEvent(
  env: Env,
  roomId: string,
  eventId: string,
  eventType: string,
): Promise<void> {
  try {
    const memberships = eventType === "m.room.member" ? ["join", "invite"] : ["join"];
    const placeholders = memberships.map(() => "?").join(", ");
    const members = await env.DB.prepare(
      `SELECT user_id FROM room_memberships WHERE room_id = ? AND membership IN (${placeholders})`,
    )
      .bind(roomId, ...memberships)
      .all<{ user_id: string }>();

    console.log(
      "[database] Notifying",
      members.results.length,
      "users of event",
      eventId,
      "users:",
      members.results.map((m) => m.user_id).join(", "),
    );

    // Notify each user's SyncDurableObject in parallel
    const notifications = members.results.map(async (member) => {
      try {
        const syncDO = env.SYNC.get(env.SYNC.idFromName(member.user_id));
        await syncDO.fetch(
          new Request("http://internal/notify", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              event_id: eventId,
              room_id: roomId,
              type: eventType,
              timestamp: Date.now(),
            }),
          }),
        );
      } catch (error) {
        // Don't fail the whole operation if one notification fails
        console.error(`[database] Failed to notify user ${member.user_id} of event:`, error);
      }
    });

    await Promise.all(notifications);
  } catch (error) {
    // Log but don't fail - event storage was successful
    console.error("[database] Failed to notify users of event:", error);
  }
}

// Fan out a stored event to all remote federation peers that have joined members in the room.
// Non-blocking — errors are logged but do not propagate to the caller.
export async function fanoutEventToFederation(
  env: Env,
  roomId: string,
  event: PDU,
  options?: { excludeServers?: string[] },
): Promise<void> {
  try {
    await fanoutEventToRemoteServers(
      createFederationOutboundPort(env),
      env.DB,
      env.SERVER_NAME,
      roomId,
      event,
      options?.excludeServers,
    );
  } catch (err) {
    console.error("[federation-fanout] Error during fanout:", err);
  }
}
