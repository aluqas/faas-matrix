import type { RoomId, UserId } from "../../../../fatrix-model/types/matrix";
import type {
  PartialStateJoinMarker,
  PartialStateStatus,
} from "../../../../fatrix-model/types/partial-state";
import { toEventId, toRoomId, toUserId } from "../../../../fatrix-model/utils/ids";

export type { PartialStateJoinMarker, PartialStateStatus };

const PARTIAL_STATE_JOIN_PREFIX = "partial_state_join";
const PARTIAL_STATE_ROOM_PREFIX = "partial_state_room";
const PARTIAL_STATE_COMPLETED_PREFIX = "partial_state_completed";
const DEFAULT_TTL_SECONDS = 60 * 15;
const COMPLETION_TTL_SECONDS = 60 * 5;

function buildPartialStateJoinCacheKey(userId: string, roomId: string): string {
  return `${PARTIAL_STATE_JOIN_PREFIX}:${userId}:${roomId}`;
}

function buildPartialStateRoomCacheKey(roomId: string): string {
  return `${PARTIAL_STATE_ROOM_PREFIX}:${roomId}`;
}

function buildPartialStateCompletionCacheKey(userId: string, roomId: string): string {
  return `${PARTIAL_STATE_COMPLETED_PREFIX}:${userId}:${roomId}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toJoinMarker(status: PartialStateStatus): PartialStateJoinMarker {
  return {
    roomId: status.roomId,
    userId: status.userId,
    eventId: status.eventId,
    startedAt: status.startedAt,
    ...(status.remoteServer ? { remoteServer: status.remoteServer } : {}),
    ...(status.serversInRoom ? { serversInRoom: status.serversInRoom } : {}),
    ...(status.encrypted === true ? { encrypted: true } : {}),
  };
}

function parsePartialStateStatus(
  raw: unknown,
  defaults: Partial<Pick<PartialStateJoinMarker, "roomId" | "userId">> = {},
  defaultPhase: PartialStateStatus["phase"] = "partial",
): PartialStateStatus | null {
  if (!isPlainObject(raw)) {
    return null;
  }

  const roomIdRaw = typeof raw["roomId"] === "string" ? raw["roomId"] : defaults.roomId;
  const userIdRaw = typeof raw["userId"] === "string" ? raw["userId"] : defaults.userId;
  const eventIdRaw = raw["eventId"];
  const startedAt = raw["startedAt"];
  if (
    typeof roomIdRaw !== "string" ||
    typeof userIdRaw !== "string" ||
    typeof eventIdRaw !== "string" ||
    typeof startedAt !== "number"
  ) {
    return null;
  }
  const roomId = toRoomId(roomIdRaw);
  const userId = toUserId(userIdRaw);
  const eventId = toEventId(eventIdRaw);
  if (!roomId || !userId || !eventId) return null;

  return {
    roomId,
    userId,
    eventId,
    startedAt,
    phase:
      raw["phase"] === "catchup_published" || raw["phase"] === "complete"
        ? raw["phase"]
        : defaultPhase,
    ...(typeof raw["remoteServer"] === "string" ? { remoteServer: raw["remoteServer"] } : {}),
    ...(Array.isArray(raw["serversInRoom"])
      ? {
          serversInRoom: raw["serversInRoom"].filter(
            (entry): entry is string => typeof entry === "string",
          ),
        }
      : {}),
    ...(raw["encrypted"] === true ? { encrypted: true } : {}),
    ...(typeof raw["catchupPublishedAt"] === "number"
      ? { catchupPublishedAt: raw["catchupPublishedAt"] }
      : {}),
    ...(typeof raw["completedAt"] === "number" ? { completedAt: raw["completedAt"] } : {}),
  };
}

export async function upsertPartialStateStatus(
  cache: KVNamespace,
  status: PartialStateStatus,
  ttlSeconds = DEFAULT_TTL_SECONDS,
): Promise<void> {
  const serialized = JSON.stringify(status);
  const writes: Promise<void>[] = [
    cache.put(buildPartialStateJoinCacheKey(status.userId, status.roomId), serialized, {
      expirationTtl: ttlSeconds,
    }),
  ];

  if (status.phase === "complete") {
    writes.push(cache.delete(buildPartialStateRoomCacheKey(status.roomId)));
  } else {
    writes.push(
      cache.put(buildPartialStateRoomCacheKey(status.roomId), serialized, {
        expirationTtl: ttlSeconds,
      }),
    );
  }

  await Promise.all(writes);
}

export async function getPartialStateStatus(
  cache: KVNamespace | undefined,
  userId: UserId,
  roomId: RoomId,
): Promise<PartialStateStatus | null> {
  if (!cache) {
    return null;
  }

  const raw = await cache.get(buildPartialStateJoinCacheKey(userId, roomId), "json");
  return parsePartialStateStatus(raw, { roomId, userId });
}

export async function getPartialStateCompletionStatus(
  cache: KVNamespace | undefined,
  userId: UserId,
  roomId: RoomId,
): Promise<PartialStateStatus | null> {
  if (!cache) {
    return null;
  }

  const raw = await cache.get(buildPartialStateCompletionCacheKey(userId, roomId), "json");
  return parsePartialStateStatus(raw, { roomId, userId }, "complete");
}

export async function consumePartialStateCompletionStatus(
  cache: KVNamespace | undefined,
  userId: UserId,
  roomId: RoomId,
): Promise<PartialStateStatus | null> {
  if (!cache) {
    return null;
  }

  const key = buildPartialStateCompletionCacheKey(userId, roomId);
  const raw = await cache.get(key, "json");
  const status = parsePartialStateStatus(raw, { roomId, userId }, "complete");
  if (!status) {
    return null;
  }

  await cache.delete(key);
  return status;
}

export async function markPartialStateJoin(
  cache: KVNamespace,
  marker: PartialStateJoinMarker,
  ttlSeconds = DEFAULT_TTL_SECONDS,
): Promise<void> {
  await upsertPartialStateStatus(
    cache,
    {
      ...marker,
      phase: "partial",
    },
    ttlSeconds,
  );
}

export async function markPartialStateCatchupPublished(
  cache: KVNamespace | undefined,
  status: PartialStateStatus,
  ttlSeconds = DEFAULT_TTL_SECONDS,
): Promise<void> {
  if (!cache) {
    return;
  }

  await upsertPartialStateStatus(
    cache,
    {
      ...status,
      phase: "catchup_published",
      catchupPublishedAt: status.catchupPublishedAt ?? Date.now(),
    },
    ttlSeconds,
  );
}

export async function getPartialStateJoin(
  cache: KVNamespace | undefined,
  userId: UserId,
  roomId: RoomId,
): Promise<PartialStateJoinMarker | null> {
  if (!cache) {
    return null;
  }

  const status = await getPartialStateStatus(cache, userId, roomId);
  return status ? toJoinMarker(status) : null;
}

export async function clearPartialStateJoin(
  cache: KVNamespace | undefined,
  userId: UserId,
  roomId: RoomId,
): Promise<void> {
  if (!cache) {
    return;
  }

  await Promise.all([
    cache.delete(buildPartialStateJoinCacheKey(userId, roomId)),
    cache.delete(buildPartialStateRoomCacheKey(roomId)),
  ]);
}

export async function markPartialStateJoinCompleted(
  cache: KVNamespace | undefined,
  marker: PartialStateJoinMarker,
  ttlSeconds = COMPLETION_TTL_SECONDS,
): Promise<void> {
  if (!cache) {
    return;
  }

  await cache.put(
    buildPartialStateCompletionCacheKey(marker.userId, marker.roomId),
    JSON.stringify({
      ...marker,
      phase: "complete",
      completedAt: Date.now(),
    } satisfies PartialStateStatus),
    {
      expirationTtl: ttlSeconds,
    },
  );
}

export async function takePartialStateJoinCompletion(
  cache: KVNamespace | undefined,
  userId: UserId,
  roomId: RoomId,
): Promise<PartialStateJoinMarker | null> {
  if (!cache) {
    return null;
  }

  const status = await consumePartialStateCompletionStatus(cache, userId, roomId);
  if (!status) {
    return null;
  }

  return toJoinMarker(status);
}

export async function getPartialStateJoinCompletion(
  cache: KVNamespace | undefined,
  userId: UserId,
  roomId: RoomId,
): Promise<PartialStateJoinMarker | null> {
  if (!cache) {
    return null;
  }

  const status = await getPartialStateCompletionStatus(cache, userId, roomId);
  return status ? toJoinMarker(status) : null;
}

export async function getPartialStateJoinForRoom(
  cache: KVNamespace | undefined,
  roomId: RoomId,
): Promise<PartialStateJoinMarker | null> {
  if (!cache) {
    return null;
  }

  const raw = await cache.get(buildPartialStateRoomCacheKey(roomId), "json");
  const status = parsePartialStateStatus(raw, { roomId });
  return status ? toJoinMarker(status) : null;
}

export async function listPartialStateJoinsForUser(
  cache: KVNamespace | undefined,
  userId: UserId,
): Promise<PartialStateJoinMarker[]> {
  if (!cache || typeof cache.list !== "function") {
    return [];
  }

  const prefix = `${PARTIAL_STATE_JOIN_PREFIX}:${userId}:`;
  const markers: PartialStateJoinMarker[] = [];
  let cursor: string | undefined;

  do {
    const page = await cache.list({ prefix, ...(cursor ? { cursor } : {}) });
    const pageMarkers = await Promise.all(
      page.keys.map(async (key) => {
        const status = parsePartialStateStatus(await cache.get(key.name, "json"));
        return status ? toJoinMarker(status) : null;
      }),
    );
    for (const marker of pageMarkers) {
      if (marker) {
        markers.push(marker);
      }
    }

    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  return markers;
}

export async function listPartialStateJoinCompletionsForUser(
  cache: KVNamespace | undefined,
  userId: UserId,
): Promise<PartialStateJoinMarker[]> {
  if (!cache || typeof cache.list !== "function") {
    return [];
  }

  const prefix = `${PARTIAL_STATE_COMPLETED_PREFIX}:${userId}:`;
  const markers: PartialStateJoinMarker[] = [];
  let cursor: string | undefined;

  do {
    const page = await cache.list({ prefix, ...(cursor ? { cursor } : {}) });
    const pageMarkers = await Promise.all(
      page.keys.map(async (key) => {
        const status = parsePartialStateStatus(await cache.get(key.name, "json"), {}, "complete");
        return status ? toJoinMarker(status) : null;
      }),
    );
    for (const marker of pageMarkers) {
      if (marker) {
        markers.push(marker);
      }
    }

    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  return markers;
}

export async function listPartialStateStatusesForUser(
  cache: KVNamespace | undefined,
  userId: UserId,
): Promise<PartialStateStatus[]> {
  if (!cache || typeof cache.list !== "function") {
    return [];
  }

  const prefix = `${PARTIAL_STATE_JOIN_PREFIX}:${userId}:`;
  const statuses: PartialStateStatus[] = [];
  let cursor: string | undefined;

  do {
    const page = await cache.list({ prefix, ...(cursor ? { cursor } : {}) });
    const pageStatuses = await Promise.all(
      page.keys.map(async (key) => parsePartialStateStatus(await cache.get(key.name, "json"))),
    );
    for (const status of pageStatuses) {
      if (status) {
        statuses.push(status);
      }
    }

    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  return statuses;
}

export async function listPartialStateCompletionStatusesForUser(
  cache: KVNamespace | undefined,
  userId: UserId,
): Promise<PartialStateStatus[]> {
  if (!cache || typeof cache.list !== "function") {
    return [];
  }

  const prefix = `${PARTIAL_STATE_COMPLETED_PREFIX}:${userId}:`;
  const statuses: PartialStateStatus[] = [];
  let cursor: string | undefined;

  do {
    const page = await cache.list({ prefix, ...(cursor ? { cursor } : {}) });
    const pageStatuses = await Promise.all(
      page.keys.map(async (key) =>
        parsePartialStateStatus(await cache.get(key.name, "json"), {}, "complete"),
      ),
    );
    for (const status of pageStatuses) {
      if (status) {
        statuses.push(status);
      }
    }

    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  return statuses;
}
