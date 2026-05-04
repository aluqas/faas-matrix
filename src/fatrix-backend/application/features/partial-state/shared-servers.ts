import {
  getServersInEncryptedRoomsWithUser,
  getServersInEncryptedRoomsWithUserExcludingRooms,
  getServersInRoomsWithUser,
  getServersInRoomsWithUserExcludingRooms,
} from "../../../../platform/cloudflare/adapters/db/database";
import { toEventId, toRoomId, toUserId } from "../../../../fatrix-model/utils/ids";
import type { PartialStateJoinMarker, PartialStateStatus } from "./tracker";
import {
  listPartialStateCompletionStatusesForUser,
  listPartialStateStatusesForUser,
} from "./tracker";

export const PARTIAL_STATE_JOIN_METADATA_EVENT_TYPE = "io.tuwunel.partial_state_join";
const PARTIAL_STATE_JOIN_METADATA_TTL_MS = 15 * 60 * 1000;

function parseMarkerContent(
  userId: string,
  roomId: string,
  content: string,
): PartialStateStatus | null {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }

    const record = parsed as Record<string, unknown>;
    const eventId = record["eventId"];
    const startedAt = record["startedAt"];
    if (typeof eventId !== "string" || typeof startedAt !== "number") {
      return null;
    }

    const validatedRoomId = toRoomId(roomId);
    const validatedUserId = toUserId(userId);
    const validatedEventId = toEventId(eventId);

    if (!validatedRoomId || !validatedUserId || !validatedEventId) {
      return null;
    }

    return {
      roomId: validatedRoomId,
      userId: validatedUserId,
      eventId: validatedEventId,
      startedAt,
      phase:
        record["phase"] === "catchup_published" || record["phase"] === "complete"
          ? record["phase"]
          : "partial",
      ...(typeof record["remoteServer"] === "string"
        ? { remoteServer: record["remoteServer"] }
        : {}),
      ...(Array.isArray(record["serversInRoom"])
        ? {
            serversInRoom: record["serversInRoom"].filter(
              (entry): entry is string => typeof entry === "string",
            ),
          }
        : {}),
      ...(record["encrypted"] === true ? { encrypted: true } : {}),
      ...(typeof record["catchupPublishedAt"] === "number"
        ? { catchupPublishedAt: record["catchupPublishedAt"] }
        : {}),
      ...(typeof record["completedAt"] === "number" ? { completedAt: record["completedAt"] } : {}),
    };
  } catch {
    return null;
  }
}

async function listPersistedPartialStateJoins(
  db: D1Database,
  userId: string,
): Promise<PartialStateStatus[]> {
  const result = await db
    .prepare(
      `
      SELECT room_id, content
      FROM account_data
      WHERE user_id = ? AND event_type = ? AND deleted = 0
    `,
    )
    .bind(userId, PARTIAL_STATE_JOIN_METADATA_EVENT_TYPE)
    .all<{ room_id: string; content: string }>();

  const cutoff = Date.now() - PARTIAL_STATE_JOIN_METADATA_TTL_MS;
  return result.results
    .map((row) => parseMarkerContent(userId, row.room_id, row.content))
    .filter(
      (marker): marker is PartialStateStatus =>
        marker !== null && marker.startedAt >= cutoff && marker.phase !== "complete",
    );
}

async function getPersistedPartialStateMarker(
  db: D1Database,
  userId: string,
  roomId: string,
): Promise<PartialStateStatus | null> {
  const row = await db
    .prepare(
      `
      SELECT content, deleted
      FROM account_data
      WHERE user_id = ? AND room_id = ? AND event_type = ?
      LIMIT 1
    `,
    )
    .bind(userId, roomId, PARTIAL_STATE_JOIN_METADATA_EVENT_TYPE)
    .first<{ content: string; deleted: number | null }>();

  if (!row || row.deleted === 1) {
    return null;
  }

  return parseMarkerContent(userId, roomId, row.content);
}

async function filterMarkersToJoinedMembership(
  db: D1Database,
  userId: string,
  markers: PartialStateStatus[],
): Promise<PartialStateStatus[]> {
  if (markers.length === 0) {
    return markers;
  }

  const roomIds = [...new Set(markers.map((marker) => marker.roomId))];
  const placeholders = roomIds.map(() => "?").join(", ");
  const result = await db
    .prepare(
      `
      SELECT room_id, membership
      FROM room_memberships
      WHERE user_id = ? AND room_id IN (${placeholders})
    `,
    )
    .bind(userId, ...roomIds)
    .all<{ room_id: string; membership: string }>();

  const joinedRoomIds = new Set(
    result.results.filter((row) => row.membership === "join").map((row) => row.room_id),
  );

  return markers.filter((marker) => joinedRoomIds.has(marker.roomId));
}

function mergeServersInRoom(
  left: string[] | undefined,
  right: string[] | undefined,
): string[] | undefined {
  const merged = [...(left ?? []), ...(right ?? [])];
  if (merged.length === 0) {
    return undefined;
  }

  return [...new Set(merged)];
}

function mergePartialStateJoinMarker(
  current: PartialStateStatus | undefined,
  next: PartialStateStatus,
): PartialStateStatus {
  if (!current) {
    return next;
  }

  return {
    ...current,
    ...next,
    startedAt: Math.max(current.startedAt, next.startedAt),
    eventId: next.startedAt >= current.startedAt ? next.eventId : current.eventId,
    remoteServer:
      next.startedAt >= current.startedAt
        ? (next.remoteServer ?? current.remoteServer)
        : (current.remoteServer ?? next.remoteServer),
    encrypted: current.encrypted === true || next.encrypted === true,
    ...(mergeServersInRoom(current.serversInRoom, next.serversInRoom)
      ? { serversInRoom: mergeServersInRoom(current.serversInRoom, next.serversInRoom) }
      : {}),
  };
}

function collectActivePartialStateMarkers(input: {
  persistedJoins: PartialStateStatus[];
  kvJoins: PartialStateStatus[];
  completedJoins: PartialStateStatus[];
}): Map<string, PartialStateStatus> {
  const completedRoomIds = new Set(input.completedJoins.map((marker) => marker.roomId));
  const activeRoomIds = new Set(input.kvJoins.map((marker) => marker.roomId));
  const partialStateMarkersByRoom = new Map<string, PartialStateStatus>();

  for (const marker of input.persistedJoins) {
    if (completedRoomIds.has(marker.roomId) && !activeRoomIds.has(marker.roomId)) {
      continue;
    }

    partialStateMarkersByRoom.set(
      marker.roomId,
      mergePartialStateJoinMarker(partialStateMarkersByRoom.get(marker.roomId), marker),
    );
  }

  for (const marker of input.kvJoins) {
    partialStateMarkersByRoom.set(
      marker.roomId,
      mergePartialStateJoinMarker(partialStateMarkersByRoom.get(marker.roomId), marker),
    );
  }

  return partialStateMarkersByRoom;
}

export function resolveActivePartialStateRoomIds(input: {
  persistedJoins: PartialStateStatus[];
  kvJoins: PartialStateStatus[];
  completedJoins: PartialStateStatus[];
}): string[] {
  return Array.from(collectActivePartialStateMarkers(input).keys());
}

export function resolveSharedServersWithPartialState(input: {
  sharedServers: string[];
  persistedJoins: PartialStateStatus[];
  kvJoins: PartialStateStatus[];
  completedJoins: PartialStateStatus[];
}): string[] {
  const partialStateMarkersByRoom = collectActivePartialStateMarkers(input);

  return [
    ...new Set([
      ...input.sharedServers,
      ...Array.from(partialStateMarkersByRoom.values()).flatMap(
        (marker) => marker.serversInRoom ?? [],
      ),
    ]),
  ];
}

export function resolveEncryptedSharedServersWithPartialState(input: {
  sharedServers: string[];
  persistedJoins: PartialStateStatus[];
  kvJoins: PartialStateStatus[];
  completedJoins: PartialStateStatus[];
}): string[] {
  const partialStateMarkersByRoom = collectActivePartialStateMarkers(input);

  return [
    ...new Set([
      ...input.sharedServers,
      ...Array.from(partialStateMarkersByRoom.values())
        .filter((marker) => marker.encrypted === true)
        .flatMap((marker) => marker.serversInRoom ?? []),
    ]),
  ];
}

export async function upsertPartialStateJoinMetadata(
  db: D1Database,
  marker: PartialStateJoinMarker | PartialStateStatus,
): Promise<void> {
  await db
    .prepare(
      `
      INSERT INTO account_data (user_id, room_id, event_type, content, deleted)
      VALUES (?, ?, ?, ?, 0)
      ON CONFLICT (user_id, room_id, event_type) DO UPDATE SET
        content = excluded.content,
        deleted = 0
    `,
    )
    .bind(
      marker.userId,
      marker.roomId,
      PARTIAL_STATE_JOIN_METADATA_EVENT_TYPE,
      JSON.stringify(marker),
    )
    .run();
}

export async function clearPartialStateJoinMetadata(
  db: D1Database,
  userId: string,
  roomId: string,
): Promise<void> {
  await db
    .prepare(
      `
      INSERT INTO account_data (user_id, room_id, event_type, content, deleted)
      VALUES (?, ?, ?, '{}', 1)
      ON CONFLICT (user_id, room_id, event_type) DO UPDATE SET
        content = excluded.content,
        deleted = 1
    `,
    )
    .bind(userId, roomId, PARTIAL_STATE_JOIN_METADATA_EVENT_TYPE)
    .run();
}

export async function getSharedServersInRoomsWithUserIncludingPartialState(
  db: D1Database,
  cache: KVNamespace | undefined,
  userId: string,
): Promise<string[]> {
  const validatedUserId = toUserId(userId);
  if (!validatedUserId) {
    return [];
  }
  const [sharedServers, persistedJoins, kvJoins, completedJoins] = await Promise.all([
    getServersInRoomsWithUser(db, validatedUserId),
    listPersistedPartialStateJoins(db, validatedUserId),
    listPartialStateStatusesForUser(cache, validatedUserId),
    listPartialStateCompletionStatusesForUser(cache, validatedUserId),
  ]);
  const [joinedPersistedJoins, joinedKvJoins] = await Promise.all([
    filterMarkersToJoinedMembership(db, validatedUserId, persistedJoins),
    filterMarkersToJoinedMembership(db, validatedUserId, kvJoins),
  ]);

  return resolveSharedServersWithPartialState({
    sharedServers,
    persistedJoins: joinedPersistedJoins,
    kvJoins: joinedKvJoins,
    completedJoins,
  });
}

export async function getSharedServersInRoomsWithUserExcludingPartialState(
  db: D1Database,
  cache: KVNamespace | undefined,
  userId: string,
): Promise<string[]> {
  const validatedUserId = toUserId(userId);
  if (!validatedUserId) {
    return [];
  }
  const [persistedJoins, kvJoins, completedJoins] = await Promise.all([
    listPersistedPartialStateJoins(db, validatedUserId),
    listPartialStateStatusesForUser(cache, validatedUserId),
    listPartialStateCompletionStatusesForUser(cache, validatedUserId),
  ]);
  const [joinedPersistedJoins, joinedKvJoins] = await Promise.all([
    filterMarkersToJoinedMembership(db, validatedUserId, persistedJoins),
    filterMarkersToJoinedMembership(db, validatedUserId, kvJoins),
  ]);
  const activePartialStateRoomIds = resolveActivePartialStateRoomIds({
    persistedJoins: joinedPersistedJoins,
    kvJoins: joinedKvJoins,
    completedJoins,
  });

  return getServersInRoomsWithUserExcludingRooms(db, validatedUserId, activePartialStateRoomIds);
}

export async function getSharedServersInEncryptedRoomsWithUserExcludingPartialState(
  db: D1Database,
  cache: KVNamespace | undefined,
  userId: string,
): Promise<string[]> {
  const validatedUserId = toUserId(userId);
  if (!validatedUserId) {
    return [];
  }
  const [persistedJoins, kvJoins, completedJoins] = await Promise.all([
    listPersistedPartialStateJoins(db, validatedUserId),
    listPartialStateStatusesForUser(cache, validatedUserId),
    listPartialStateCompletionStatusesForUser(cache, validatedUserId),
  ]);
  const [joinedPersistedJoins, joinedKvJoins] = await Promise.all([
    filterMarkersToJoinedMembership(db, validatedUserId, persistedJoins),
    filterMarkersToJoinedMembership(db, validatedUserId, kvJoins),
  ]);
  const activePartialStateRoomIds = resolveActivePartialStateRoomIds({
    persistedJoins: joinedPersistedJoins,
    kvJoins: joinedKvJoins,
    completedJoins,
  });

  return getServersInEncryptedRoomsWithUserExcludingRooms(
    db,
    validatedUserId,
    activePartialStateRoomIds,
  );
}

export async function getSharedServersInEncryptedRoomsWithUserIncludingPartialState(
  db: D1Database,
  cache: KVNamespace | undefined,
  userId: string,
): Promise<string[]> {
  const validatedUserId = toUserId(userId);
  if (!validatedUserId) {
    return [];
  }
  const [sharedServers, persistedJoins, kvJoins, completedJoins] = await Promise.all([
    getServersInEncryptedRoomsWithUser(db, validatedUserId),
    listPersistedPartialStateJoins(db, validatedUserId),
    listPartialStateStatusesForUser(cache, validatedUserId),
    listPartialStateCompletionStatusesForUser(cache, validatedUserId),
  ]);
  const [joinedPersistedJoins, joinedKvJoins] = await Promise.all([
    filterMarkersToJoinedMembership(db, validatedUserId, persistedJoins),
    filterMarkersToJoinedMembership(db, validatedUserId, kvJoins),
  ]);

  return resolveEncryptedSharedServersWithPartialState({
    sharedServers,
    persistedJoins: joinedPersistedJoins,
    kvJoins: joinedKvJoins,
    completedJoins,
  });
}

export async function getPersistedPartialStateStatus(
  db: D1Database,
  userId: string,
  roomId: string,
): Promise<PartialStateStatus | null> {
  const marker = await getPersistedPartialStateMarker(db, userId, roomId);
  return marker && marker.phase !== "complete" ? marker : null;
}

export async function getPersistedPartialStateCompletionStatus(
  db: D1Database,
  userId: string,
  roomId: string,
): Promise<PartialStateStatus | null> {
  const marker = await getPersistedPartialStateMarker(db, userId, roomId);
  return marker?.phase === "complete" ? marker : null;
}

export async function takePersistedPartialStateCompletionStatus(
  db: D1Database,
  userId: string,
  roomId: string,
): Promise<PartialStateStatus | null> {
  const marker = await getPersistedPartialStateCompletionStatus(db, userId, roomId);
  if (!marker) {
    return null;
  }

  await clearPartialStateJoinMetadata(db, userId, roomId);
  return marker;
}
