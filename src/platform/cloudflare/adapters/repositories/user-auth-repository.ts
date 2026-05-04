import { createKyselyBuilder, executeKyselyQueryFirst } from "../db/kysely";
import type { UserId } from "../../../../fatrix-model/types";

interface UserRow {
  user_id: string;
  password_hash: string | null;
}

interface IdpUserLinkRow {
  user_id: string;
}

interface UserAuthDatabase {
  users: UserRow;
  idp_user_links: IdpUserLinkRow;
}

const qb = createKyselyBuilder<UserAuthDatabase>();

export async function getUserPasswordHash(db: D1Database, userId: UserId): Promise<string | null> {
  const row = await executeKyselyQueryFirst<Pick<UserRow, "password_hash">>(
    db,
    qb.selectFrom("users").select("password_hash").where("user_id", "=", userId).limit(1),
  );

  return row?.password_hash ?? null;
}

export async function hasIdentityProviderLink(db: D1Database, userId: UserId): Promise<boolean> {
  const row = await executeKyselyQueryFirst<{ count: number | null }>(
    db,
    qb
      .selectFrom("idp_user_links")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .where("user_id", "=", userId),
  );

  return (row?.count ?? 0) > 0;
}

export async function userExists(db: D1Database, userId: UserId): Promise<boolean> {
  const row = await executeKyselyQueryFirst<{ user_id: string }>(
    db,
    qb.selectFrom("users").select("user_id").where("user_id", "=", userId).limit(1),
  );

  return row !== null;
}
