import { sql, type RawBuilder } from "kysely";
import {
  createKyselyBuilder,
  executeKyselyQuery,
  executeKyselyQueryFirst,
  type CompiledQuery,
} from "../../infra/db/kysely";
import type { RoomId, UserId } from "../../shared/types";
import { extractServerNameFromMatrixId } from "../../shared/utils/matrix-ids";

interface MembershipRow {
  room_id: string;
  user_id: string;
  membership: string;
}

interface RealtimeRoomDatabase {
  room_memberships: MembershipRow;
}

const qb = createKyselyBuilder<RealtimeRoomDatabase>();

function asCompiledQuery<T>(query: RawBuilder<T>): CompiledQuery {
  return {
    compile: () => query.compile(qb),
  };
}

export async function isUserJoinedToRealtimeRoom(
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
      .where("membership", "=", "join")
      .limit(1),
  );

  return row !== null;
}

export async function listRemoteJoinedServersInRoom(
  db: D1Database,
  roomId: RoomId,
  localServerName: string,
): Promise<string[]> {
  const rows = await executeKyselyQuery<{ user_id: string }>(
    db,
    asCompiledQuery(sql<{ user_id: string }>`
      WITH memberships AS (
        SELECT user_id
        FROM room_memberships
        WHERE room_id = ${roomId} AND membership = 'join'
        UNION
        SELECT rs.state_key AS user_id
        FROM room_state rs
        INNER JOIN events e ON e.event_id = rs.event_id
        WHERE rs.room_id = ${roomId}
          AND rs.event_type = 'm.room.member'
          AND json_extract(e.content, '$.membership') = 'join'
      )
      SELECT DISTINCT user_id FROM memberships
    `),
  );

  return Array.from(
    new Set(
      rows
        .map((row) => extractServerNameFromMatrixId(row.user_id))
        .filter((server): server is string => Boolean(server) && server !== localServerName),
    ),
  );
}
