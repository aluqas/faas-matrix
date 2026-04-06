import { createKyselyBuilder, executeKyselyQuery } from "../../services/kysely";

interface ServerKeyRow {
  key_id: string;
  public_key: string;
  valid_until: number | null;
  is_current: number;
}

interface ServerKeysDatabase {
  server_keys: ServerKeyRow;
}

export interface CurrentServerKeyRecord {
  keyId: string;
  publicKey: string;
  validUntil: number | null;
}

const qb = createKyselyBuilder<ServerKeysDatabase>();

export async function listCurrentServerKeys(
  db: D1Database,
  keyId?: string | null,
): Promise<CurrentServerKeyRecord[]> {
  const rows = keyId
    ? await executeKyselyQuery<Pick<ServerKeyRow, "key_id" | "public_key" | "valid_until">>(
        db,
        qb
          .selectFrom("server_keys")
          .select(["key_id", "public_key", "valid_until"])
          .where("key_id", "=", keyId),
      )
    : await executeKyselyQuery<Pick<ServerKeyRow, "key_id" | "public_key" | "valid_until">>(
        db,
        qb
          .selectFrom("server_keys")
          .select(["key_id", "public_key", "valid_until"])
          .where("is_current", "=", 1),
      );

  return rows.map((row) => ({
    keyId: row.key_id,
    publicKey: row.public_key,
    validUntil: row.valid_until,
  }));
}
