import { sql, type RawBuilder } from "kysely";
import { type CompiledQuery, createKyselyBuilder, executeKyselyQuery } from "../../infra/db/kysely";
import type { UserId } from "../../shared/types";

interface KeysChangeRow {
  user_id: string;
  change_type: string;
}

interface UserOnlyRow {
  user_id: string;
}

type KeysQueryDatabase = Record<string, never>;

const qb = createKyselyBuilder<KeysQueryDatabase>();

function asCompiledQuery<T>(query: RawBuilder<T>): CompiledQuery {
  return {
    compile: () => query.compile(qb),
  };
}

export function listVisibleLocalDeviceKeyChanges(
  db: D1Database,
  userId: UserId,
  fromDeviceKeyPosition: number,
  toDeviceKeyPosition: number,
): Promise<KeysChangeRow[]> {
  return executeKyselyQuery<KeysChangeRow>(
    db,
    asCompiledQuery(sql<KeysChangeRow>`
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
      joined_members AS (
        SELECT room_id, user_id
        FROM current_memberships
        WHERE membership = 'join'
      )
      SELECT DISTINCT dkc.user_id, dkc.change_type
      FROM device_key_changes dkc
      WHERE dkc.stream_position > ${fromDeviceKeyPosition}
        AND dkc.stream_position <= ${toDeviceKeyPosition}
        AND (
          dkc.user_id = ${userId}
          OR EXISTS (
            SELECT 1
            FROM joined_members requester
            JOIN joined_members target ON requester.room_id = target.room_id
            WHERE requester.user_id = ${userId}
              AND target.user_id = dkc.user_id
          )
        )
    `),
  );
}

export function listVisibleRemoteDeviceKeyChanges(
  db: D1Database,
  userId: UserId,
  fromDeviceKeyPosition: number,
  toDeviceKeyPosition: number,
): Promise<UserOnlyRow[]> {
  return executeKyselyQuery<UserOnlyRow>(
    db,
    asCompiledQuery(sql<UserOnlyRow>`
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
      joined_members AS (
        SELECT room_id, user_id
        FROM current_memberships
        WHERE membership = 'join'
      )
      SELECT DISTINCT rdls.user_id
      FROM remote_device_list_streams rdls
      WHERE rdls.stream_id > ${fromDeviceKeyPosition}
        AND rdls.stream_id <= ${toDeviceKeyPosition}
        AND EXISTS (
          SELECT 1
          FROM joined_members requester
          JOIN joined_members target ON requester.room_id = target.room_id
          WHERE requester.user_id = ${userId}
            AND target.user_id = rdls.user_id
        )
    `),
  );
}

export function listNewlySharedUsers(
  db: D1Database,
  userId: UserId,
  fromEventPosition: number,
  toEventPosition: number,
): Promise<UserOnlyRow[]> {
  return executeKyselyQuery<UserOnlyRow>(
    db,
    asCompiledQuery(sql<UserOnlyRow>`
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
      joined_members AS (
        SELECT room_id, user_id
        FROM current_memberships
        WHERE membership = 'join'
      )
      SELECT DISTINCT e.state_key AS user_id
      FROM events e
      JOIN joined_members requester_joined
        ON requester_joined.room_id = e.room_id
       AND requester_joined.user_id = ${userId}
      JOIN joined_members target_joined
        ON target_joined.room_id = e.room_id
       AND target_joined.user_id = e.state_key
      WHERE e.event_type = 'm.room.member'
        AND e.stream_ordering > ${fromEventPosition}
        AND e.stream_ordering <= ${toEventPosition}
        AND e.state_key IS NOT NULL
        AND e.state_key != ${userId}
        AND json_extract(e.content, '$.membership') = 'join'
        AND NOT EXISTS (
          SELECT 1
          FROM joined_members shared_requester
          JOIN joined_members shared_target
            ON shared_requester.room_id = shared_target.room_id
          WHERE shared_requester.user_id = ${userId}
            AND shared_target.user_id = e.state_key
            AND shared_requester.room_id != e.room_id
        )
    `),
  );
}

export function listCurrentMembersInJoinedRooms(
  db: D1Database,
  userId: UserId,
  fromEventPosition: number,
  toEventPosition: number,
): Promise<UserOnlyRow[]> {
  return executeKyselyQuery<UserOnlyRow>(
    db,
    asCompiledQuery(sql<UserOnlyRow>`
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
      joined_members AS (
        SELECT room_id, user_id
        FROM current_memberships
        WHERE membership = 'join'
      )
      SELECT DISTINCT joined_members.user_id
      FROM events requester_join_event
      JOIN joined_members
        ON joined_members.room_id = requester_join_event.room_id
      WHERE requester_join_event.event_type = 'm.room.member'
        AND requester_join_event.stream_ordering > ${fromEventPosition}
        AND requester_join_event.stream_ordering <= ${toEventPosition}
        AND requester_join_event.state_key = ${userId}
        AND json_extract(requester_join_event.content, '$.membership') = 'join'
    `),
  );
}

export function listNoLongerSharedUsers(
  db: D1Database,
  userId: UserId,
  fromEventPosition: number,
  toEventPosition: number,
): Promise<UserOnlyRow[]> {
  return executeKyselyQuery<UserOnlyRow>(
    db,
    asCompiledQuery(sql<UserOnlyRow>`
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
      joined_members AS (
        SELECT room_id, user_id
        FROM current_memberships
        WHERE membership = 'join'
      )
      SELECT DISTINCT left_user_id AS user_id
      FROM (
        SELECT e.state_key AS left_user_id
        FROM events e
        JOIN joined_members requester_joined
          ON requester_joined.room_id = e.room_id
         AND requester_joined.user_id = ${userId}
        WHERE e.event_type = 'm.room.member'
          AND e.stream_ordering > ${fromEventPosition}
          AND e.stream_ordering <= ${toEventPosition}
          AND e.state_key IS NOT NULL
          AND e.state_key != ${userId}
          AND json_extract(e.content, '$.membership') IN ('leave', 'ban')
          AND NOT EXISTS (
            SELECT 1
            FROM joined_members shared_requester
            JOIN joined_members shared_target
              ON shared_requester.room_id = shared_target.room_id
            WHERE shared_requester.user_id = ${userId}
              AND shared_target.user_id = e.state_key
          )

        UNION

        SELECT other_membership.user_id AS left_user_id
        FROM events e
        JOIN current_memberships requester_membership
          ON requester_membership.room_id = e.room_id
         AND requester_membership.user_id = ${userId}
         AND requester_membership.membership IN ('leave', 'ban')
        JOIN joined_members other_membership
          ON other_membership.room_id = e.room_id
        WHERE e.event_type = 'm.room.member'
          AND e.stream_ordering > ${fromEventPosition}
          AND e.stream_ordering <= ${toEventPosition}
          AND e.state_key = ${userId}
          AND other_membership.user_id != ${userId}
          AND json_extract(e.content, '$.membership') IN ('leave', 'ban')
          AND NOT EXISTS (
            SELECT 1
            FROM joined_members shared_requester
            JOIN joined_members shared_target
              ON shared_requester.room_id = shared_target.room_id
            WHERE shared_requester.user_id = ${userId}
              AND shared_target.user_id = other_membership.user_id
          )
      )
    `),
  );
}
