import { createKyselyBuilder, executeKyselyBatch, executeKyselyQuery } from "../../services/kysely";

interface RemoteServerKeyRow {
  server_name: string;
  key_id: string;
  public_key: string;
  valid_from: number;
  valid_until: number | null;
  fetched_at: number;
  verified: number;
}

interface RemoteServerKeysDatabase {
  remote_server_keys: RemoteServerKeyRow;
}

export interface RemoteServerKeyRecord {
  serverName: string;
  keyId: string;
  publicKey: string;
  validFrom: number;
  validUntil: number | null;
  fetchedAt: number;
  verified: boolean;
}

const qb = createKyselyBuilder<RemoteServerKeysDatabase>();

function toRemoteServerKeyRecord(row: RemoteServerKeyRow): RemoteServerKeyRecord {
  return {
    serverName: row.server_name,
    keyId: row.key_id,
    publicKey: row.public_key,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    fetchedAt: row.fetched_at,
    verified: row.verified === 1,
  };
}

export async function listNonExpiredRemoteServerKeys(
  db: D1Database,
  serverName: string,
  now: number,
): Promise<RemoteServerKeyRecord[]> {
  const rows = await executeKyselyQuery<RemoteServerKeyRow>(
    db,
    qb
      .selectFrom("remote_server_keys")
      .selectAll()
      .where("server_name", "=", serverName)
      .where((eb) => eb.or([eb("valid_until", "is", null), eb("valid_until", ">", now)])),
  );
  return rows.map(toRemoteServerKeyRecord);
}

export async function upsertRemoteServerKeys(
  db: D1Database,
  keys: readonly RemoteServerKeyRecord[],
): Promise<void> {
  if (keys.length === 0) {
    return;
  }

  await executeKyselyBatch(
    db,
    keys.map((key) =>
      qb
        .insertInto("remote_server_keys")
        .values({
          server_name: key.serverName,
          key_id: key.keyId,
          public_key: key.publicKey,
          valid_from: key.validFrom,
          valid_until: key.validUntil,
          fetched_at: key.fetchedAt,
          verified: key.verified ? 1 : 0,
        })
        .onConflict((oc) =>
          oc.columns(["server_name", "key_id"]).doUpdateSet({
            public_key: key.publicKey,
            valid_from: key.validFrom,
            valid_until: key.validUntil,
            fetched_at: key.fetchedAt,
            verified: key.verified ? 1 : 0,
          }),
        ),
    ),
  );
}
