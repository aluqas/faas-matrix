import { sql } from "kysely";
import type { PresenceState, RoomId, UserId } from "../../../../fatrix-model/types";
import { toUserId } from "../../../../fatrix-model/utils/ids";
import {
  createKyselyBuilder,
  executeKyselyQuery,
  executeKyselyQueryFirst,
  executeKyselyRun,
} from "../db/kysely";

const PRESENCE_TIMEOUT_MS = 5 * 60 * 1000;

interface PresenceRow {
  user_id: string;
  presence: string;
  status_msg: string | null;
  last_active_ts: number;
  currently_active: number | null;
}

interface RoomStateRow {
  room_id: string;
  event_id: string;
  event_type: string;
  state_key: string;
}

interface EventRow {
  event_id: string;
  content: string;
}

interface PresenceDatabase {
  presence: PresenceRow;
  room_state: RoomStateRow;
  events: EventRow;
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
  userId: UserId,
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
  userId: UserId,
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
  userIds: UserId[],
  cache?: KVNamespace,
): Promise<Record<UserId, PresenceRecord>> {
  if (userIds.length === 0) return {};

  const now = Date.now();
  const byUser: Partial<Record<UserId, PresenceRecord>> = {};
  const uncachedIds: UserId[] = [];

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
      const typedUserId = toUserId(row.user_id);
      if (typedUserId) {
        byUser[typedUserId] = toPresenceRecord(row, now);
      }
    }
  }

  for (const uid of userIds) {
    byUser[uid] ??= {
      presence: "offline",
      statusMsg: undefined,
      lastActiveAgo: 0,
      currentlyActive: false,
    };
  }

  return byUser as Record<UserId, PresenceRecord>;
}

export async function touchLastActive(
  db: D1Database,
  userId: UserId,
  lastActiveTs: number = Date.now(),
): Promise<void> {
  await executeKyselyRun(
    db,
    qb.updateTable("presence").set({ last_active_ts: lastActiveTs }).where("user_id", "=", userId),
  );
}

export async function listVisibleUsers(
  db: D1Database,
  userId: UserId,
  roomIds: RoomId[],
): Promise<UserId[]> {
  if (roomIds.length === 0) return [];

  const rows = await executeKyselyQuery<{ user_id: string }>(
    db,
    qb
      .selectFrom("room_state as rs")
      .innerJoin("events as e", "rs.event_id", "e.event_id")
      .select("rs.state_key as user_id")
      .where("rs.room_id", "in", roomIds)
      .where("rs.event_type", "=", "m.room.member")
      .where("rs.state_key", "!=", userId)
      .where(sql<boolean>`json_extract(e.content, '$.membership') = 'join'`)
      .distinct(),
  );

  return rows
    .map((row) => toUserId(row.user_id))
    .filter((value): value is UserId => value !== null);
}

export async function writePresenceToCache(
  cache: KVNamespace,
  userId: UserId,
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
