import {
  createKyselyBuilder,
  executeKyselyQuery,
  executeKyselyQueryFirst,
} from "../../services/kysely";
import type { Membership } from "../../types";

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
  eventId: string;
}

const qb = createKyselyBuilder<MembershipDatabase>();

export async function getMembershipForUser(
  db: D1Database,
  roomId: string,
  userId: string,
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
  return { membership: row.membership as Membership, eventId: row.event_id };
}

export async function isUserJoinedToRoom(
  db: D1Database,
  roomId: string,
  userId: string,
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

export async function getJoinedRoomIdsForUser(db: D1Database, userId: string): Promise<string[]> {
  const rows = await executeKyselyQuery<{ room_id: string }>(
    db,
    qb
      .selectFrom("room_memberships")
      .select("room_id")
      .where("user_id", "=", userId)
      .where("membership", "=", "join"),
  );
  return rows.map((row) => row.room_id);
}
