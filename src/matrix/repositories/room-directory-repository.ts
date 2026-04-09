import { createKyselyBuilder, executeKyselyQueryFirst } from "../../services/kysely";
import type { RoomId } from "../../types";

interface RoomAliasRow {
  alias: string;
  room_id: string;
}

interface RoomDirectoryDatabase {
  room_aliases: RoomAliasRow;
}

const qb = createKyselyBuilder<RoomDirectoryDatabase>();

export async function findRoomIdByAlias(
  db: D1Database,
  alias: string,
): Promise<RoomId | null> {
  const row = await executeKyselyQueryFirst<Pick<RoomAliasRow, "room_id">>(
    db,
    qb.selectFrom("room_aliases").select("room_id").where("alias", "=", alias),
  );

  return (row?.room_id as RoomId | undefined) ?? null;
}
