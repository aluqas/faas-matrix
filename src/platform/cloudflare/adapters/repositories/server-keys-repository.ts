import {
  createKyselyBuilder,
  executeKyselyBatch,
  executeKyselyQuery,
  executeKyselyQueryFirst,
  type CompiledQuery,
} from "../db/kysely";

interface ServerKeyRow {
  key_id: string;
  public_key: string;
  private_key: string | null;
  private_key_jwk: string | null;
  key_version: number | null;
  valid_from: number | null;
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

export interface ServerSigningKeyRecord {
  keyId: string;
  privateKeyJwk: JsonWebKey;
}

const qb = createKyselyBuilder<ServerKeysDatabase>();

function parseJsonWebKey(value: string | null): JsonWebKey | null {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value) as JsonWebKey;
  } catch {
    return null;
  }
}

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

export async function getCurrentServerSigningKeyRecord(
  db: D1Database,
): Promise<ServerSigningKeyRecord | null> {
  const row = await executeKyselyQueryFirst<Pick<ServerKeyRow, "key_id" | "private_key_jwk">>(
    db,
    qb
      .selectFrom("server_keys")
      .select(["key_id", "private_key_jwk"])
      .where("is_current", "=", 1)
      .where("key_version", "=", 2)
      .limit(1),
  );

  if (!row) {
    return null;
  }

  const privateKeyJwk = parseJsonWebKey(row.private_key_jwk);
  if (!privateKeyJwk) {
    return null;
  }

  return {
    keyId: row.key_id,
    privateKeyJwk,
  };
}

export function buildDeactivateCurrentServerKeysQuery(): CompiledQuery {
  return qb.updateTable("server_keys").set({ is_current: 0 });
}

export function buildInsertCurrentServerSigningKeyQuery(input: {
  keyId: string;
  publicKey: string;
  privateKeyJwk: JsonWebKey;
  validFrom: number;
  validUntil: number;
}): CompiledQuery {
  const serializedPrivateKey = JSON.stringify(input.privateKeyJwk);

  return qb.insertInto("server_keys").values({
    key_id: input.keyId,
    public_key: input.publicKey,
    private_key: serializedPrivateKey,
    private_key_jwk: serializedPrivateKey,
    key_version: 2,
    valid_from: input.validFrom,
    valid_until: input.validUntil,
    is_current: 1,
  });
}

export async function replaceCurrentServerSigningKey(
  db: D1Database,
  input: {
    keyId: string;
    publicKey: string;
    privateKeyJwk: JsonWebKey;
    validFrom: number;
    validUntil: number;
  },
): Promise<void> {
  await executeKyselyBatch(db, [
    buildDeactivateCurrentServerKeysQuery(),
    buildInsertCurrentServerSigningKeyQuery(input),
  ]);
}
