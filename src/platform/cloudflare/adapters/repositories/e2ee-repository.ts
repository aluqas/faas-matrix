import { sql, type Generated, type RawBuilder } from "kysely";
import {
  type CompiledQuery,
  createKyselyBuilder,
  executeKyselyBatch,
  executeKyselyQuery,
  executeKyselyQueryFirst,
  executeKyselyRun,
} from "../db/kysely";
import type {
  CrossSigningKeysStore,
  JsonObject,
  JsonObjectMap,
} from "../../../../fatrix-model/types/client";
import type {
  FederationClaimedOneTimeKeyRecord,
  FederationDeviceSignatureRecord,
  FederationStoredDeviceRecord,
} from "../../../../fatrix-model/types/e2ee";
import { parseJsonObject } from "../../../../fatrix-model/types/e2ee";

interface UserRow {
  user_id: string;
}

interface DeviceRow {
  device_id: string;
  user_id: string;
  display_name: string | null;
  last_seen_ts: number | null;
  last_seen_ip: string | null;
  created_at: Generated<number>;
}

interface CrossSigningSignatureRow {
  id: Generated<number>;
  user_id: string;
  key_id: string;
  signer_user_id: string;
  signer_key_id: string;
  signature: string;
  created_at: Generated<number>;
}

interface CrossSigningKeyRow {
  user_id: string;
  key_type: string;
  key_id: string;
  key_data: string;
  created_at: Generated<number>;
}

interface DeviceKeyChangeRow {
  id: Generated<number>;
  user_id: string;
  device_id: string | null;
  change_type: string;
  stream_position: number;
  created_at: Generated<number>;
}

interface StreamPositionRow {
  stream_name: string;
  position: number;
}

interface OneTimeKeyRow {
  id: Generated<number>;
  user_id: string;
  device_id: string;
  algorithm: string;
  key_id: string;
  key_data: string;
  created_at: Generated<number>;
  claimed: number;
  claimed_at: number | null;
}

interface FallbackKeyRow {
  user_id: string;
  device_id: string;
  algorithm: string;
  key_id: string;
  key_data: string;
  used: number;
  created_at: Generated<number>;
}

interface FederationE2EEDatabase {
  users: UserRow;
  devices: DeviceRow;
  cross_signing_signatures: CrossSigningSignatureRow;
  cross_signing_keys: CrossSigningKeyRow;
  device_key_changes: DeviceKeyChangeRow;
  stream_positions: StreamPositionRow;
  one_time_keys: OneTimeKeyRow;
  fallback_keys: FallbackKeyRow;
}

const qb = createKyselyBuilder<FederationE2EEDatabase>();

function asCompiledQuery<T>(query: RawBuilder<T>): CompiledQuery {
  return {
    compile: () => query.compile(qb),
  };
}

function parseJsonObjectString(value: string): FederationClaimedOneTimeKeyRecord["keyData"] {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error("Stored E2EE JSON payload is not valid JSON", { cause: error });
  }

  const parsed = parseJsonObject(parsedJson);
  if (!parsed) {
    throw new Error("Stored E2EE JSON payload is not a valid object");
  }

  return parsed;
}

export function toFederationDeviceSignatureRecord(
  row: Pick<CrossSigningSignatureRow, "signer_user_id" | "signer_key_id" | "signature">,
): FederationDeviceSignatureRecord {
  return {
    signerUserId: row.signer_user_id as FederationDeviceSignatureRecord["signerUserId"],
    signerKeyId: row.signer_key_id,
    signature: row.signature,
  };
}

export function toFederationStoredDeviceRecord(
  row: Pick<DeviceRow, "device_id" | "display_name">,
): FederationStoredDeviceRecord {
  return {
    deviceId: row.device_id,
    displayName: row.display_name,
  };
}

export function toFederationClaimedOneTimeKeyRecord(
  row: Pick<OneTimeKeyRow, "key_id" | "key_data"> | Pick<FallbackKeyRow, "key_id" | "key_data">,
): FederationClaimedOneTimeKeyRecord {
  return {
    keyId: row.key_id,
    keyData: parseJsonObjectString(row.key_data),
  };
}

export async function localUserExists(db: D1Database, userId: string): Promise<boolean> {
  const row = await executeKyselyQueryFirst<UserRow>(
    db,
    qb.selectFrom("users").select("user_id").where("user_id", "=", userId),
  );
  return row !== null;
}

export async function listCrossSigningSignaturesForKey(
  db: D1Database,
  userId: string,
  keyId: string,
): Promise<FederationDeviceSignatureRecord[]> {
  const rows = await executeKyselyQuery<
    Pick<CrossSigningSignatureRow, "signer_user_id" | "signer_key_id" | "signature">
  >(
    db,
    qb
      .selectFrom("cross_signing_signatures")
      .select(["signer_user_id", "signer_key_id", "signature"])
      .where("user_id", "=", userId)
      .where("key_id", "=", keyId),
  );

  return rows.map((row) => toFederationDeviceSignatureRecord(row));
}

export async function listUserDevices(
  db: D1Database,
  userId: string,
): Promise<FederationStoredDeviceRecord[]> {
  const rows = await executeKyselyQuery<Pick<DeviceRow, "device_id" | "display_name">>(
    db,
    qb.selectFrom("devices").select(["device_id", "display_name"]).where("user_id", "=", userId),
  );

  return rows.map((row) => toFederationStoredDeviceRecord(row));
}

export async function getDeviceKeyStreamId(db: D1Database, userId: string): Promise<number> {
  const row = await executeKyselyQueryFirst<{ stream_id: number | null }>(
    db,
    qb
      .selectFrom("device_key_changes")
      .select((eb) => eb.fn.max("stream_position").as("stream_id"))
      .where("user_id", "=", userId),
  );

  return row?.stream_id ?? 0;
}

function stringifyJson(value: JsonObject): string {
  return JSON.stringify(value);
}

export async function hasCrossSigningKeysBackup(db: D1Database, userId: string): Promise<boolean> {
  const row = await executeKyselyQueryFirst<{ count: number | null }>(
    db,
    qb
      .selectFrom("cross_signing_keys")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .where("user_id", "=", userId),
  );

  return (row?.count ?? 0) > 0;
}

export function buildUpsertOneTimeKeyQuery(
  userId: string,
  deviceId: string,
  algorithm: string,
  keyId: string,
  keyData: JsonObject,
): CompiledQuery {
  return qb
    .insertInto("one_time_keys")
    .values({
      user_id: userId,
      device_id: deviceId,
      algorithm,
      key_id: keyId,
      key_data: stringifyJson(keyData),
      claimed: 0,
      claimed_at: null,
    })
    .onConflict((oc) =>
      oc.columns(["user_id", "device_id", "algorithm", "key_id"]).doUpdateSet({
        key_data: stringifyJson(keyData),
        claimed: 0,
        claimed_at: null,
      }),
    );
}

export function buildUpsertFallbackKeyQuery(
  userId: string,
  deviceId: string,
  algorithm: string,
  keyId: string,
  keyData: JsonObject,
): CompiledQuery {
  return qb
    .insertInto("fallback_keys")
    .values({
      user_id: userId,
      device_id: deviceId,
      algorithm,
      key_id: keyId,
      key_data: stringifyJson(keyData),
      used: 0,
    })
    .onConflict((oc) =>
      oc.columns(["user_id", "device_id", "algorithm"]).doUpdateSet({
        key_id: keyId,
        key_data: stringifyJson(keyData),
        used: 0,
      }),
    );
}

function buildOneTimeKeyBackupQueries(
  userId: string,
  deviceId: string,
  oneTimeKeys: JsonObjectMap,
): CompiledQuery[] {
  const queries: CompiledQuery[] = [];

  for (const [keyId, keyData] of Object.entries(oneTimeKeys)) {
    const [algorithm] = keyId.split(":");
    if (!algorithm) {
      continue;
    }
    queries.push(buildUpsertOneTimeKeyQuery(userId, deviceId, algorithm, keyId, keyData));
  }

  return queries;
}

function buildFallbackKeyBackupQueries(
  userId: string,
  deviceId: string,
  fallbackKeys: JsonObjectMap,
): CompiledQuery[] {
  const queries: CompiledQuery[] = [];

  for (const [keyId, keyData] of Object.entries(fallbackKeys)) {
    const [algorithm] = keyId.split(":");
    if (!algorithm) {
      continue;
    }
    queries.push(buildUpsertFallbackKeyQuery(userId, deviceId, algorithm, keyId, keyData));
  }

  return queries;
}

async function executeKeyBackupQueries(
  db: D1Database,
  queries: readonly CompiledQuery[],
): Promise<void> {
  if (queries.length === 0) {
    return;
  }

  await executeKyselyBatch(db, queries);
}

export function upsertOneTimeKeyBackups(
  db: D1Database,
  userId: string,
  deviceId: string,
  oneTimeKeys: JsonObjectMap,
): Promise<void> {
  return executeKeyBackupQueries(db, buildOneTimeKeyBackupQueries(userId, deviceId, oneTimeKeys));
}

export function upsertFallbackKeyBackups(
  db: D1Database,
  userId: string,
  deviceId: string,
  fallbackKeys: JsonObjectMap,
): Promise<void> {
  return executeKeyBackupQueries(db, buildFallbackKeyBackupQueries(userId, deviceId, fallbackKeys));
}

export async function markStoredOneTimeKeyClaimed(
  db: D1Database,
  userId: string,
  deviceId: string,
  keyId: string,
  claimedAt: number,
): Promise<void> {
  await executeKyselyRun(
    db,
    qb
      .updateTable("one_time_keys")
      .set({
        claimed: 1,
        claimed_at: claimedAt,
      })
      .where("user_id", "=", userId)
      .where("device_id", "=", deviceId)
      .where("key_id", "=", keyId),
  );
}

export async function getNextDeviceKeyStreamPosition(db: D1Database): Promise<number> {
  const row = await executeKyselyQueryFirst<{ position: number | null }>(
    db,
    qb
      .updateTable("stream_positions")
      .set({
        position: sql<number>`position + 1`,
      })
      .where("stream_name", "=", "device_keys")
      .returning("position"),
  );

  return row?.position ?? 1;
}

export function buildRecordDeviceKeyChangeQuery(
  userId: string,
  deviceId: string | null,
  changeType: string,
  streamPosition: number,
): CompiledQuery {
  return qb.insertInto("device_key_changes").values({
    user_id: userId,
    device_id: deviceId,
    change_type: changeType,
    stream_position: streamPosition,
  });
}

export async function recordDeviceKeyChangeWithKysely(
  db: D1Database,
  userId: string,
  deviceId: string | null,
  changeType: string,
): Promise<void> {
  const streamPosition = await getNextDeviceKeyStreamPosition(db);
  await executeKyselyRun(
    db,
    buildRecordDeviceKeyChangeQuery(userId, deviceId, changeType, streamPosition),
  );
}

export function buildUpsertCrossSigningKeyBackupQuery(
  userId: string,
  keyType: "master" | "self_signing" | "user_signing",
  keyId: string,
  keyData: CrossSigningKeysStore["master"],
): CompiledQuery {
  return qb
    .insertInto("cross_signing_keys")
    .values({
      user_id: userId,
      key_type: keyType,
      key_id: keyId,
      key_data: stringifyJson(keyData ?? {}),
    })
    .onConflict((oc) =>
      oc.columns(["user_id", "key_type"]).doUpdateSet({
        key_id: keyId,
        key_data: stringifyJson(keyData ?? {}),
      }),
    );
}

export async function storeCrossSigningKeysBackup(
  db: D1Database,
  userId: string,
  keys: CrossSigningKeysStore,
  recordChange: boolean,
): Promise<void> {
  const queries: CompiledQuery[] = [];

  if (keys.master) {
    const keyId = Object.keys(keys.master.keys ?? {})[0] ?? "";
    queries.push(buildUpsertCrossSigningKeyBackupQuery(userId, "master", keyId, keys.master));
  }
  if (keys.self_signing) {
    const keyId = Object.keys(keys.self_signing.keys ?? {})[0] ?? "";
    queries.push(
      buildUpsertCrossSigningKeyBackupQuery(userId, "self_signing", keyId, keys.self_signing),
    );
  }
  if (keys.user_signing) {
    const keyId = Object.keys(keys.user_signing.keys ?? {})[0] ?? "";
    queries.push(
      buildUpsertCrossSigningKeyBackupQuery(userId, "user_signing", keyId, keys.user_signing),
    );
  }

  if (queries.length === 0) {
    return;
  }

  if (recordChange) {
    const streamPosition = await getNextDeviceKeyStreamPosition(db);
    queries.push(buildRecordDeviceKeyChangeQuery(userId, null, "update", streamPosition));
  }

  await executeKyselyBatch(db, queries);
}

export async function upsertCrossSigningSignature(
  db: D1Database,
  userId: string,
  keyId: string,
  signerUserId: string,
  signerKeyId: string,
  signature: string,
): Promise<void> {
  await executeKyselyRun(
    db,
    qb
      .insertInto("cross_signing_signatures")
      .values({
        user_id: userId,
        key_id: keyId,
        signer_user_id: signerUserId,
        signer_key_id: signerKeyId,
        signature,
      })
      .onConflict((oc) =>
        oc
          .columns(["user_id", "key_id", "signer_user_id", "signer_key_id"])
          .doUpdateSet({ signature }),
      ),
  );
}

export async function claimUnclaimedOneTimeKey(
  db: D1Database,
  userId: string,
  deviceId: string,
  algorithm: string,
  claimedAt: number,
): Promise<FederationClaimedOneTimeKeyRecord | null> {
  const row = await executeKyselyQueryFirst<Pick<OneTimeKeyRow, "key_id" | "key_data">>(
    db,
    asCompiledQuery(sql<Pick<OneTimeKeyRow, "key_id" | "key_data">>`
      WITH selected AS (
        SELECT id
        FROM one_time_keys
        WHERE user_id = ${userId}
          AND device_id = ${deviceId}
          AND algorithm = ${algorithm}
          AND claimed = 0
        ORDER BY id
        LIMIT 1
      )
      UPDATE one_time_keys
      SET claimed = 1, claimed_at = ${claimedAt}
      WHERE id IN (SELECT id FROM selected)
      RETURNING key_id, key_data
    `),
  );

  if (!row) {
    return null;
  }

  return toFederationClaimedOneTimeKeyRecord(row);
}

export async function claimFallbackKey(
  db: D1Database,
  userId: string,
  deviceId: string,
  algorithm: string,
): Promise<FederationClaimedOneTimeKeyRecord | null> {
  const row = await executeKyselyQueryFirst<Pick<FallbackKeyRow, "key_id" | "key_data">>(
    db,
    asCompiledQuery(sql<Pick<FallbackKeyRow, "key_id" | "key_data">>`
      UPDATE fallback_keys
      SET used = 1
      WHERE user_id = ${userId}
        AND device_id = ${deviceId}
        AND algorithm = ${algorithm}
        AND used = 0
      RETURNING key_id, key_data
    `),
  );

  if (!row) {
    return null;
  }

  return toFederationClaimedOneTimeKeyRecord(row);
}
