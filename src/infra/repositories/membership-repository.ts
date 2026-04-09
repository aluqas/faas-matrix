import {
  createKyselyBuilder,
  executeKyselyQuery,
  executeKyselyQueryFirst,
} from "../../infra/db/kysely";
import type { EventId, Membership, RoomId, UserId } from "../../shared/types";
import { toEventId, toRoomId } from "../../shared/utils/ids";

interface MembershipRow {
  room_id: string;
  user_id: string;
  membership: string;
  event_id: string;
  display_name: string | null;
  avatar_url: string | null;
}

interface MembershipDatabase {
  room_memberships: MembershipRow;
}

export interface MembershipRecord {
  membership: Membership;
  eventId: EventId;
}

const qb = createKyselyBuilder<MembershipDatabase>();

/**
 * Shared CTE chain: denormalized `room_memberships` ∪ supplemental `room_state`
 * rows not yet reflected in `room_memberships`, then `joined_members` (membership = join).
 * Embed after `WITH` in SQL (comma-separated CTE names).
 */
export const EFFECTIVE_MEMBERSHIPS_AND_JOINED_MEMBERS_CTE = `
  current_memberships AS (
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
  joined_members AS (
    SELECT room_id, user_id
    FROM current_memberships
    WHERE membership = 'join'
  )
`;

/**
 * All room IDs where the user has an effective membership row (any of join/invite/leave/ban/knock),
 * including partial-state rows present only in `room_state`.
 */
export async function getUserRoomIdsWithEffectiveMembership(
  db: D1Database,
  userId: UserId,
  membership?: Membership,
): Promise<RoomId[]> {
  let query = `
    WITH membership_sources AS (
      SELECT room_id, membership
      FROM room_memberships
      WHERE user_id = ?

      UNION

      SELECT
        rs.room_id,
        json_extract(e.content, '$.membership') AS membership
      FROM room_state rs
      JOIN events e ON rs.event_id = e.event_id
      WHERE rs.event_type = 'm.room.member'
        AND rs.state_key = ?
        AND NOT EXISTS (
          SELECT 1
          FROM room_memberships rm
          WHERE rm.room_id = rs.room_id
            AND rm.user_id = rs.state_key
        )
    )
    SELECT DISTINCT room_id
    FROM membership_sources
    WHERE membership IN ('join', 'invite', 'leave', 'ban', 'knock')
  `;
  const params: string[] = [userId, userId];

  if (membership) {
    query += ` AND membership = ?`;
    params.push(membership);
  }

  const result = await db
    .prepare(query)
    .bind(...params)
    .all<{ room_id: string }>();
  return result.results
    .map((r) => toRoomId(r.room_id))
    .filter((roomId): roomId is RoomId => roomId !== null);
}

export async function getMembershipForUser(
  db: D1Database,
  roomId: RoomId,
  userId: UserId,
): Promise<MembershipRecord | null> {
  const row = await executeKyselyQueryFirst<{ membership: string; event_id: string }>(
    db,
    qb
      .selectFrom("room_memberships")
      .select(["membership", "event_id"])
      .where("room_id", "=", roomId)
      .where("user_id", "=", userId),
  );
  if (!row) return null;
  const eventId = toEventId(row.event_id);
  if (!eventId) {
    throw new Error(`Invalid event_id format in room_memberships: ${row.event_id}`);
  }
  return { membership: row.membership as Membership, eventId };
}

export async function isUserJoinedToRoom(
  db: D1Database,
  roomId: RoomId,
  userId: UserId,
): Promise<boolean> {
  const row = await executeKyselyQueryFirst<{ room_id: string }>(
    db,
    qb
      .selectFrom("room_memberships")
      .select("room_id")
      .where("room_id", "=", roomId)
      .where("user_id", "=", userId)
      .where("membership", "=", "join"),
  );
  return row !== null;
}

export async function getJoinedRoomIdsForUser(db: D1Database, userId: UserId): Promise<RoomId[]> {
  const rows = await executeKyselyQuery<{ room_id: string }>(
    db,
    qb
      .selectFrom("room_memberships")
      .select("room_id")
      .where("user_id", "=", userId)
      .where("membership", "=", "join"),
  );
  return rows
    .map((row) => toRoomId(row.room_id))
    .filter((roomId): roomId is RoomId => roomId !== null);
}

/**
 * Returns the IDs of all rooms the user is effectively joined to, including
 * partial-state rooms where the membership exists in `room_state` but has
 * not yet been denormalized into `room_memberships`.
 *
 * This is the canonical "effective join membership" read-path fact used by:
 *   - Sync room inclusion  (getUserRooms in infra/db/database.ts)
 *   - Device-list propagation  (getDeviceListChanges in runtime/cloudflare/matrix-repositories.ts)
 *   - Presence visibility  (listVisibleUsers in repositories/presence-repository.ts)
 *
 * All three paths must agree on which rooms "count" for membership, especially
 * during a partial-state join where the remote room state is still being fetched.
 *
 * SQL strategy: UNION `room_memberships` (fast, denormalized) with the
 * `room_state` → `events` join for any membership events NOT yet reflected in
 * `room_memberships`.  The NOT EXISTS guard prevents double-counting.
 */
export function getJoinedRoomIdsIncludingPartialState(
  db: D1Database,
  userId: UserId,
): Promise<RoomId[]> {
  return getUserRoomIdsWithEffectiveMembership(db, userId, "join");
}

/**
 * Returns the effective join count for a room, including partial-state members.
 * Used to compute `joined_count` in sync responses without querying the full list.
 */
export async function getEffectiveJoinedMemberCount(
  db: D1Database,
  roomId: RoomId,
): Promise<number> {
  const result = await db
    .prepare(
      `
      WITH effective_members AS (
        SELECT user_id
        FROM room_memberships
        WHERE room_id = ? AND membership = 'join'

        UNION

        SELECT rs.state_key AS user_id
        FROM room_state rs
        JOIN events e ON rs.event_id = e.event_id
        WHERE rs.room_id = ?
          AND rs.event_type = 'm.room.member'
          AND rs.state_key IS NOT NULL
          AND json_extract(e.content, '$.membership') = 'join'
          AND NOT EXISTS (
            SELECT 1
            FROM room_memberships rm
            WHERE rm.room_id = rs.room_id
              AND rm.user_id = rs.state_key
          )
      )
      SELECT COUNT(*) AS cnt FROM effective_members
      `,
    )
    .bind(roomId, roomId)
    .first<{ cnt: number }>();
  return result?.cnt ?? 0;
}
