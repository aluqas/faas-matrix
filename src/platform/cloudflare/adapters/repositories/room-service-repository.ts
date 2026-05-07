import { sql, type RawBuilder } from "kysely";
import { createKyselyBuilder, executeKyselyQuery, type CompiledQuery } from "../db/kysely";
import type { Device, RoomId, UserId } from "../../../../fatrix-model/types";
import { toUserId } from "../../../../fatrix-model/utils/ids";

type DeviceRow = {
  device_id: string;
  user_id: string;
  display_name: string | null;
  last_seen_ts: number | null;
  last_seen_ip: string | null;
};

type ServerNameRow = {
  server_name: string | null;
};

interface RoomServiceDatabase {
  devices: {
    device_id: string;
    user_id: string;
    display_name: string | null;
    last_seen_ts: number | null;
    last_seen_ip: string | null;
  };
  room_memberships: {
    room_id: string;
    user_id: string;
    membership: string;
  };
  room_state: {
    room_id: string;
    event_type: string;
    state_key: string | null;
    event_id: string;
  };
  events: {
    event_id: string;
    content: string;
  };
}

const qb = createKyselyBuilder<RoomServiceDatabase>();

function asCompiledQuery<T>(query: RawBuilder<T>): CompiledQuery {
  return {
    compile: () => query.compile(qb),
  };
}

export async function getUserDevicesForRoomService(
  db: D1Database,
  userId: UserId,
): Promise<Device[]> {
  const rows = await executeKyselyQuery<DeviceRow>(
    db,
    asCompiledQuery(sql<DeviceRow>`
      SELECT device_id, user_id, display_name, last_seen_ts, last_seen_ip
      FROM devices
      WHERE user_id = ${userId}
    `),
  );

  return rows.flatMap((row) => {
    const typedUserId = toUserId(row.user_id);
    if (!typedUserId) {
      return [];
    }

    return [
      {
        device_id: row.device_id,
        user_id: typedUserId,
        ...(row.display_name !== null ? { display_name: row.display_name } : {}),
        ...(row.last_seen_ts !== null ? { last_seen_ts: row.last_seen_ts } : {}),
        ...(row.last_seen_ip !== null ? { last_seen_ip: row.last_seen_ip } : {}),
      },
    ];
  });
}

/**
 * Returns distinct remote server names that have joined members in the given room,
 * excluding the local server. Used to populate `sharedServersAfterJoin` for
 * device-list publication upon room join, including non-encrypted rooms.
 */
export async function getRemoteServersInRoom(
  db: D1Database,
  roomId: RoomId,
  localServerName: string,
): Promise<string[]> {
  const rows = await executeKyselyQuery<ServerNameRow>(
    db,
    asCompiledQuery(sql<ServerNameRow>`
      WITH current_members AS (
        SELECT user_id FROM room_memberships WHERE room_id = ${roomId} AND membership = 'join'

        UNION

        SELECT rs.state_key AS user_id
        FROM room_state rs
        JOIN events e ON rs.event_id = e.event_id
        WHERE rs.room_id = ${roomId}
          AND rs.event_type = 'm.room.member'
          AND rs.state_key IS NOT NULL
          AND json_extract(e.content, '$.membership') = 'join'
          AND NOT EXISTS (
            SELECT 1 FROM room_memberships rm
            WHERE rm.room_id = rs.room_id AND rm.user_id = rs.state_key
          )
      )
      SELECT DISTINCT
        CASE
          WHEN INSTR(user_id, ':') > 0 THEN SUBSTR(user_id, INSTR(user_id, ':') + 1)
          ELSE NULL
        END AS server_name
      FROM current_members
    `),
  );
  return rows
    .map((row) => row.server_name)
    .filter((server): server is string => server !== null && server !== localServerName);
}

export async function getEncryptedSharedServersForRoomService(
  db: D1Database,
  userId: UserId,
): Promise<string[]> {
  const rows = await executeKyselyQuery<ServerNameRow>(
    db,
    asCompiledQuery(sql<ServerNameRow>`
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
        WHERE user_id = ${userId} AND membership = 'join'
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
      FROM encrypted_joined_rooms jr
      JOIN joined_members jm ON jr.room_id = jm.room_id
      WHERE jm.user_id != ${userId}
    `),
  );

  return rows.map((row) => row.server_name).filter((server): server is string => server !== null);
}
