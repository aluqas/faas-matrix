import { createKyselyBuilder, executeKyselyQueryFirst, executeKyselyRun } from "../db/kysely";
import type { ProfileField, ProfileResponseBody } from "../../../../fatrix-model/types/profile";
import type { Generated } from "kysely";

interface UserRow {
  user_id: string;
  display_name: string | null;
  avatar_url: string | null;
  updated_at: Generated<number> | null;
}

interface ProfileDatabase {
  users: UserRow;
}

const qb = createKyselyBuilder<ProfileDatabase>();

type ProfileFieldUpdate = Partial<Record<ProfileField, string | null>>;

export async function getLocalProfileRecord(
  db: D1Database,
  userId: string,
): Promise<ProfileResponseBody | null> {
  const row = await executeKyselyQueryFirst<Pick<UserRow, "display_name" | "avatar_url">>(
    db,
    qb.selectFrom("users").select(["display_name", "avatar_url"]).where("user_id", "=", userId),
  );

  if (!row) {
    return null;
  }

  return {
    displayname: row.display_name ?? null,
    avatar_url: row.avatar_url ?? null,
  };
}

export async function updateLocalProfile(
  db: D1Database,
  userId: string,
  update: ProfileFieldUpdate,
): Promise<void> {
  const updatedAt = Date.now();

  if (update.displayname !== undefined) {
    await executeKyselyRun(
      db,
      qb
        .updateTable("users")
        .set({ display_name: update.displayname, updated_at: updatedAt })
        .where("user_id", "=", userId),
    );
  }

  if (update.avatar_url !== undefined) {
    await executeKyselyRun(
      db,
      qb
        .updateTable("users")
        .set({ avatar_url: update.avatar_url, updated_at: updatedAt })
        .where("user_id", "=", userId),
    );
  }
}
