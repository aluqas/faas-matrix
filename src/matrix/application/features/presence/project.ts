import type { PresenceState } from "../../../../types";
import type { SyncEventFilter } from "../../sync-projection";
import { applyEventFilter } from "../../sync-projection";
import { runClientEffect } from "../../effect-runtime";
import { withLogContext } from "../../logging";
import type { PresenceProjectionQuery, PresenceSyncProjection } from "./contracts";

const PRESENCE_TIMEOUT = 5 * 60 * 1000;

async function listVisibleUsers(
  db: D1Database,
  userId: string,
  roomIds: string[],
): Promise<string[]> {
  if (roomIds.length === 0) {
    return [];
  }

  const placeholders = roomIds.map(() => "?").join(",");
  const result = await db
    .prepare(`
      SELECT DISTINCT rs.state_key AS user_id
      FROM room_state rs
      JOIN events e ON rs.event_id = e.event_id
      WHERE rs.room_id IN (${placeholders})
        AND rs.event_type = 'm.room.member'
        AND json_extract(e.content, '$.membership') = 'join'
        AND rs.state_key != ?
    `)
    .bind(...roomIds, userId)
    .all<{ user_id: string }>();

  return result.results.map((row) => row.user_id);
}

export async function getPresenceForUsers(
  db: D1Database,
  userIds: string[],
  cache?: KVNamespace,
): Promise<
  Record<
    string,
    {
      presence: PresenceState;
      status_msg?: string | undefined;
      last_active_ago?: number | undefined;
      currently_active?: boolean | undefined;
    }
  >
> {
  if (userIds.length === 0) {
    return {};
  }

  const now = Date.now();
  const byUser: Record<
    string,
    {
      presence: PresenceState;
      status_msg?: string | undefined;
      last_active_ago?: number | undefined;
      currently_active?: boolean | undefined;
    }
  > = {};
  const uncachedUserIds: string[] = [];

  if (cache) {
    for (const userId of userIds) {
      const cached = (await cache.get(`presence:${userId}`, "json")) as {
        presence: string;
        status_msg: string | null;
        last_active_ts: number;
      } | null;

      if (!cached) {
        uncachedUserIds.push(userId);
        continue;
      }

      const isActive = now - cached.last_active_ts < PRESENCE_TIMEOUT;
      byUser[userId] = {
        presence: (cached.presence === "online" && !isActive
          ? "unavailable"
          : cached.presence) as PresenceState,
        status_msg: cached.status_msg || undefined,
        last_active_ago: now - cached.last_active_ts,
        currently_active: isActive && cached.presence === "online",
      };
    }
  } else {
    uncachedUserIds.push(...userIds);
  }

  if (uncachedUserIds.length > 0) {
    const placeholders = uncachedUserIds.map(() => "?").join(",");
    const results = await db
      .prepare(`
        SELECT user_id, presence, status_msg, last_active_ts, currently_active
        FROM presence
        WHERE user_id IN (${placeholders})
      `)
      .bind(...uncachedUserIds)
      .all<{
        user_id: string;
        presence: string;
        status_msg: string | null;
        last_active_ts: number;
        currently_active?: number;
      }>();

    for (const row of results.results) {
      const isActive = now - row.last_active_ts < PRESENCE_TIMEOUT;
      byUser[row.user_id] = {
        presence: (row.presence === "online" && !isActive
          ? "unavailable"
          : row.presence) as PresenceState,
        status_msg: row.status_msg || undefined,
        last_active_ago: now - row.last_active_ts,
        currently_active: row.currently_active === 1 || (isActive && row.presence === "online"),
      };
    }
  }

  return byUser;
}

export async function projectPresenceEvents(
  db: D1Database,
  cache: KVNamespace | undefined,
  query: PresenceProjectionQuery,
): Promise<PresenceSyncProjection> {
  const logger = withLogContext({
    component: "presence",
    operation: "project",
    user_id: query.userId,
    debugEnabled: query.debugEnabled,
  });
  const visibleUsers = await listVisibleUsers(db, query.userId, query.roomIds);
  const presenceByUser = await getPresenceForUsers(db, visibleUsers, cache);

  const events = Object.entries(presenceByUser).map(([sender, content]) => ({
    type: "m.presence" as const,
    sender,
    content: {
      presence: content.presence,
      status_msg: content.status_msg,
      last_active_ago: content.last_active_ago,
      currently_active: content.currently_active,
    },
  }));

  const projection = {
    events: applyEventFilter(events, query.filter as SyncEventFilter | undefined),
  };
  await runClientEffect(
    logger.debug("presence.project.result", {
      room_count: query.roomIds.length,
      visible_user_count: visibleUsers.length,
      event_count: projection.events.length,
    }),
  );

  return projection;
}
