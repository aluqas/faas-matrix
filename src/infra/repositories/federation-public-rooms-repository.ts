import { sql, type RawBuilder } from "kysely";
import {
  createKyselyBuilder,
  executeKyselyQuery,
  executeKyselyQueryFirst,
  type CompiledQuery,
} from "../../infra/db/kysely";

interface RoomRow {
  room_id: string;
  created_at: number | null;
  is_public: number;
}

interface RoomMembershipRow {
  room_id: string;
  membership: string;
}

interface EventRow {
  event_id: string;
  content: string;
}

interface RoomStateRow {
  room_id: string;
  event_id: string;
  event_type: string;
}

interface RoomAliasRow {
  room_id: string;
  alias: string;
}

interface FederationPublicRoomsDatabase {
  rooms: RoomRow;
  room_memberships: RoomMembershipRow;
  events: EventRow;
  room_state: RoomStateRow;
  room_aliases: RoomAliasRow;
}

export interface FederationPublicRoomInfo {
  room_id: string;
  name?: string;
  topic?: string;
  canonical_alias?: string;
  avatar_url?: string;
  join_rule: string;
  num_joined_members: number;
  world_readable: boolean;
  guest_can_join: boolean;
  room_type?: string;
}

type StateContentRow = { content: string };

const qb = createKyselyBuilder<FederationPublicRoomsDatabase>();

function asCompiledQuery<T>(query: RawBuilder<T>): CompiledQuery {
  return {
    compile: () => query.compile(qb),
  };
}

function parseJsonField<T>(value: string | null | undefined, key: string): T | undefined {
  if (!value) {
    return undefined;
  }
  try {
    return (JSON.parse(value) as Record<string, T>)[key];
  } catch {
    return undefined;
  }
}

export async function listPublicRoomIds(
  db: D1Database,
  limit: number,
  offset: number,
  searchTerm?: string,
): Promise<string[]> {
  if (searchTerm) {
    const loweredSearchTerm = `%${searchTerm.toLowerCase()}%`;
    const rows = await executeKyselyQuery<{ room_id: string }>(
      db,
      asCompiledQuery(sql<{ room_id: string }>`
        SELECT DISTINCT r.room_id
        FROM rooms r
        LEFT JOIN room_state rs_name ON rs_name.room_id = r.room_id AND rs_name.event_type = 'm.room.name'
        LEFT JOIN events e_name ON rs_name.event_id = e_name.event_id
        LEFT JOIN room_state rs_topic ON rs_topic.room_id = r.room_id AND rs_topic.event_type = 'm.room.topic'
        LEFT JOIN events e_topic ON rs_topic.event_id = e_topic.event_id
        LEFT JOIN room_aliases ra ON ra.room_id = r.room_id
        WHERE r.is_public = 1
          AND (
            LOWER(e_name.content) LIKE ${loweredSearchTerm}
            OR LOWER(e_topic.content) LIKE ${loweredSearchTerm}
            OR LOWER(ra.alias) LIKE ${loweredSearchTerm}
          )
        ORDER BY r.created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `),
    );
    return rows.map((row) => row.room_id);
  }

  const rows = await executeKyselyQuery<{ room_id: string }>(
    db,
    qb
      .selectFrom("rooms")
      .select("room_id")
      .where("is_public", "=", 1)
      .orderBy("created_at", "desc")
      .limit(limit)
      .offset(offset),
  );
  return rows.map((row) => row.room_id);
}

export async function countPublicRooms(db: D1Database): Promise<number> {
  const row = await executeKyselyQueryFirst<{ count: number | null }>(
    db,
    qb
      .selectFrom("rooms")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .where("is_public", "=", 1),
  );
  return row?.count ?? 0;
}

async function getStateContent(
  db: D1Database,
  roomId: string,
  eventType: string,
): Promise<string | null> {
  const row = await executeKyselyQueryFirst<StateContentRow>(
    db,
    asCompiledQuery(sql<StateContentRow>`
      SELECT e.content AS content
      FROM room_state rs
      JOIN events e ON rs.event_id = e.event_id
      WHERE rs.room_id = ${roomId} AND rs.event_type = ${eventType}
    `),
  );
  return row?.content ?? null;
}

export async function getPublicRoomInfo(
  db: D1Database,
  roomId: string,
): Promise<FederationPublicRoomInfo> {
  const [
    nameContent,
    topicContent,
    aliasContent,
    avatarContent,
    joinRuleContent,
    historyContent,
    guestContent,
    createContent,
    memberCountRow,
  ] = await Promise.all([
    getStateContent(db, roomId, "m.room.name"),
    getStateContent(db, roomId, "m.room.topic"),
    getStateContent(db, roomId, "m.room.canonical_alias"),
    getStateContent(db, roomId, "m.room.avatar"),
    getStateContent(db, roomId, "m.room.join_rules"),
    getStateContent(db, roomId, "m.room.history_visibility"),
    getStateContent(db, roomId, "m.room.guest_access"),
    getStateContent(db, roomId, "m.room.create"),
    executeKyselyQueryFirst<{ count: number | null }>(
      db,
      qb
        .selectFrom("room_memberships")
        .select((eb) => eb.fn.countAll<number>().as("count"))
        .where("room_id", "=", roomId)
        .where("membership", "=", "join"),
    ),
  ]);

  const historyVisibility =
    parseJsonField<string>(historyContent, "history_visibility") ?? "shared";
  const guestAccess = parseJsonField<string>(guestContent, "guest_access") === "can_join";

  return {
    room_id: roomId,
    name: parseJsonField<string>(nameContent, "name"),
    topic: parseJsonField<string>(topicContent, "topic"),
    canonical_alias: parseJsonField<string>(aliasContent, "alias"),
    avatar_url: parseJsonField<string>(avatarContent, "url"),
    join_rule: parseJsonField<string>(joinRuleContent, "join_rule") ?? "invite",
    num_joined_members: memberCountRow?.count ?? 0,
    world_readable: historyVisibility === "world_readable",
    guest_can_join: guestAccess,
    room_type: parseJsonField<string>(createContent, "type"),
  };
}
