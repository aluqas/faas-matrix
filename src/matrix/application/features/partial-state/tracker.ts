export interface PartialStateJoinMarker {
  roomId: string;
  userId: string;
  eventId: string;
  remoteServer?: string;
  serversInRoom?: string[];
  startedAt: number;
}

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

function parsePartialStateJoinMarker(
  raw: unknown,
  defaults: Partial<Pick<PartialStateJoinMarker, "roomId" | "userId">> = {},
): PartialStateJoinMarker | null {
  if (!isPlainObject(raw)) {
    return null;
  }

  const roomId = typeof raw["roomId"] === "string" ? raw["roomId"] : defaults.roomId;
  const userId = typeof raw["userId"] === "string" ? raw["userId"] : defaults.userId;
  const eventId = raw["eventId"];
  const startedAt = raw["startedAt"];
  if (
    typeof roomId !== "string" ||
    typeof userId !== "string" ||
    typeof eventId !== "string" ||
    typeof startedAt !== "number"
  ) {
    return null;
  }

  return {
    roomId,
    userId,
    eventId,
    startedAt,
    ...(typeof raw["remoteServer"] === "string" ? { remoteServer: raw["remoteServer"] } : {}),
    ...(Array.isArray(raw["serversInRoom"])
      ? {
          serversInRoom: raw["serversInRoom"].filter(
            (entry): entry is string => typeof entry === "string",
          ),
        }
      : {}),
  };
}

export async function markPartialStateJoin(
  cache: KVNamespace,
  marker: PartialStateJoinMarker,
  ttlSeconds = DEFAULT_TTL_SECONDS,
): Promise<void> {
  const serialized = JSON.stringify(marker);
  await Promise.all([
    cache.put(buildPartialStateJoinCacheKey(marker.userId, marker.roomId), serialized, {
      expirationTtl: ttlSeconds,
    }),
    cache.put(buildPartialStateRoomCacheKey(marker.roomId), serialized, {
      expirationTtl: ttlSeconds,
    }),
  ]);
}

export async function getPartialStateJoin(
  cache: KVNamespace | undefined,
  userId: string,
  roomId: string,
): Promise<PartialStateJoinMarker | null> {
  if (!cache) {
    return null;
  }

  const raw = await cache.get(buildPartialStateJoinCacheKey(userId, roomId), "json");
  return parsePartialStateJoinMarker(raw, { roomId, userId });
}

export async function clearPartialStateJoin(
  cache: KVNamespace | undefined,
  userId: string,
  roomId: string,
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
    JSON.stringify(marker),
    {
      expirationTtl: ttlSeconds,
    },
  );
}

export async function takePartialStateJoinCompletion(
  cache: KVNamespace | undefined,
  userId: string,
  roomId: string,
): Promise<PartialStateJoinMarker | null> {
  if (!cache) {
    return null;
  }

  const key = buildPartialStateCompletionCacheKey(userId, roomId);
  const raw = await cache.get(key, "json");
  const marker = parsePartialStateJoinMarker(raw, { roomId, userId });
  if (!marker) {
    return null;
  }

  await cache.delete(key);
  return marker;
}

export async function getPartialStateJoinForRoom(
  cache: KVNamespace | undefined,
  roomId: string,
): Promise<PartialStateJoinMarker | null> {
  if (!cache) {
    return null;
  }

  const raw = await cache.get(buildPartialStateRoomCacheKey(roomId), "json");
  return parsePartialStateJoinMarker(raw, { roomId });
}

export async function listPartialStateJoinsForUser(
  cache: KVNamespace | undefined,
  userId: string,
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
      page.keys.map(async (key) => parsePartialStateJoinMarker(await cache.get(key.name, "json"))),
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
