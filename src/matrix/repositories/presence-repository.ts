import type { PresenceState } from "../../types";
import {
  createKyselyBuilder,
  executeKyselyQuery,
  executeKyselyQueryFirst,
  executeKyselyRun,
} from "../../services/kysely";

const PRESENCE_TIMEOUT_MS = 5 * 60 * 1000;

interface PresenceRow {
  user_id: string;
  presence: string;
  status_msg: string | null;
  last_active_ts: number;
  currently_active: number | null;
}

interface PresenceDatabase {
  presence: PresenceRow;
}

const qb = createKyselyBuilder<PresenceDatabase>();

export interface PresenceRecord {
  presence: PresenceState;
  statusMsg: string | undefined;
  lastActiveAgo: number;
  currentlyActive: boolean;
}

function toPresenceRecord(row: PresenceRow, now: number): PresenceRecord {
  const isActive = now - row.last_active_ts < PRESENCE_TIMEOUT_MS;
  const effectivePresence =
    row.presence === "online" && !isActive ? "unavailable" : (row.presence as PresenceState);
  return {
    presence: effectivePresence,
    statusMsg: row.status_msg ?? undefined,
    lastActiveAgo: now - row.last_active_ts,
    currentlyActive: row.currently_active === 1 || (isActive && row.presence === "online"),
  };
}

export async function upsertPresence(
  db: D1Database,
  userId: string,
  presence: string,
  statusMessage: string | null,
  lastActiveTs: number,
  currentlyActive: boolean = false,
): Promise<void> {
  await executeKyselyRun(
    db,
    qb
      .insertInto("presence")
      .values({
        user_id: userId,
        presence,
        status_msg: statusMessage,
        last_active_ts: lastActiveTs,
        currently_active: currentlyActive ? 1 : 0,
      })
      .onConflict((oc) =>
        oc.column("user_id").doUpdateSet({
          presence: (eb) => eb.ref("excluded.presence"),
          status_msg: (eb) => eb.ref("excluded.status_msg"),
          last_active_ts: (eb) => eb.ref("excluded.last_active_ts"),
          currently_active: (eb) => eb.ref("excluded.currently_active"),
        }),
      ),
  );
}

export async function findPresenceByUserId(
  db: D1Database,
  userId: string,
  cache?: KVNamespace,
): Promise<PresenceRecord | null> {
  const now = Date.now();

  if (cache) {
    const cached = await cache.get(`presence:${userId}`, "json");
    if (cached) {
      return toPresenceRecord(
        {
          user_id: userId,
          ...(cached as Omit<PresenceRow, "user_id" | "currently_active">),
          currently_active: null,
        },
        now,
      );
    }
  }

  const row = await executeKyselyQueryFirst<PresenceRow>(
    db,
    qb.selectFrom("presence").selectAll().where("user_id", "=", userId),
  );
  return row ? toPresenceRecord(row, now) : null;
}

export async function findPresenceByUserIds(
  db: D1Database,
  userIds: string[],
  cache?: KVNamespace,
): Promise<Record<string, PresenceRecord>> {
  if (userIds.length === 0) return {};

  const now = Date.now();
  const byUser: Record<string, PresenceRecord> = {};
  const uncachedIds: string[] = [];

  if (cache) {
    for (const uid of userIds) {
      const cached = await cache.get(`presence:${uid}`, "json");
      if (cached) {
        byUser[uid] = toPresenceRecord(
          {
            user_id: uid,
            ...(cached as Omit<PresenceRow, "user_id" | "currently_active">),
            currently_active: null,
          },
          now,
        );
      } else {
        uncachedIds.push(uid);
      }
    }
  } else {
    uncachedIds.push(...userIds);
  }

  if (uncachedIds.length > 0) {
    const rows = await executeKyselyQuery<PresenceRow>(
      db,
      qb.selectFrom("presence").selectAll().where("user_id", "in", uncachedIds),
    );
    for (const row of rows) {
      byUser[row.user_id] = toPresenceRecord(row, now);
    }
  }

  for (const uid of userIds) {
    if (!byUser[uid]) {
      byUser[uid] = {
        presence: "offline",
        statusMsg: undefined,
        lastActiveAgo: 0,
        currentlyActive: false,
      };
    }
  }

  return byUser;
}

export async function touchLastActive(
  db: D1Database,
  userId: string,
  lastActiveTs: number = Date.now(),
): Promise<void> {
  await executeKyselyRun(
    db,
    qb.updateTable("presence").set({ last_active_ts: lastActiveTs }).where("user_id", "=", userId),
  );
}

export async function listVisibleUsers(
  db: D1Database,
  userId: string,
  roomIds: string[],
): Promise<string[]> {
  if (roomIds.length === 0) return [];

  const placeholders = roomIds.map(() => "?").join(",");
  const result = await db
    .prepare(
      `SELECT DISTINCT rs.state_key AS user_id
       FROM room_state rs
       JOIN events e ON rs.event_id = e.event_id
       WHERE rs.room_id IN (${placeholders})
         AND rs.event_type = 'm.room.member'
         AND json_extract(e.content, '$.membership') = 'join'
         AND rs.state_key != ?`,
    )
    .bind(...roomIds, userId)
    .all<{ user_id: string }>();

  return result.results.map((row) => row.user_id);
}

export async function writePresenceToCache(
  cache: KVNamespace,
  userId: string,
  presence: string,
  statusMessage: string | null,
  lastActiveTs: number,
): Promise<void> {
  await cache.put(
    `presence:${userId}`,
    JSON.stringify({ presence, status_msg: statusMessage, last_active_ts: lastActiveTs }),
    { expirationTtl: 5 * 60 },
  );
}
