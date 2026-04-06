import type { Generated } from "kysely";
import {
  createKyselyBuilder,
  executeKyselyQuery,
  executeKyselyQueryFirst,
  executeKyselyRun,
} from "../../services/kysely";
import type {
  FederationClaimedOneTimeKeyRecord,
  FederationDeviceSignatureRecord,
  FederationStoredDeviceRecord,
} from "../../types/e2ee";
import { isJsonObject } from "../../types/common";

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

interface DeviceKeyChangeRow {
  id: Generated<number>;
  user_id: string;
  device_id: string | null;
  change_type: string;
  stream_position: number;
  created_at: Generated<number>;
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
  device_key_changes: DeviceKeyChangeRow;
  one_time_keys: OneTimeKeyRow;
  fallback_keys: FallbackKeyRow;
}

const qb = createKyselyBuilder<FederationE2EEDatabase>();

function parseJsonObjectString(value: string): FederationClaimedOneTimeKeyRecord["keyData"] | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isJsonObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
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

  return rows.map((row) => ({
    signerUserId: row.signer_user_id as FederationDeviceSignatureRecord["signerUserId"],
    signerKeyId: row.signer_key_id,
    signature: row.signature,
  }));
}

export async function listUserDevices(
  db: D1Database,
  userId: string,
): Promise<FederationStoredDeviceRecord[]> {
  const rows = await executeKyselyQuery<Pick<DeviceRow, "device_id" | "display_name">>(
    db,
    qb.selectFrom("devices").select(["device_id", "display_name"]).where("user_id", "=", userId),
  );

  return rows.map((row) => ({
    deviceId: row.device_id as FederationStoredDeviceRecord["deviceId"],
    displayName: row.display_name,
  }));
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

export async function findUnclaimedOneTimeKey(
  db: D1Database,
  userId: string,
  deviceId: string,
  algorithm: string,
): Promise<(FederationClaimedOneTimeKeyRecord & { id: number }) | null> {
  const row = await executeKyselyQueryFirst<Pick<OneTimeKeyRow, "id" | "key_id" | "key_data">>(
    db,
    qb
      .selectFrom("one_time_keys")
      .select(["id", "key_id", "key_data"])
      .where("user_id", "=", userId)
      .where("device_id", "=", deviceId)
      .where("algorithm", "=", algorithm)
      .where("claimed", "=", 0)
      .limit(1),
  );

  if (!row) {
    return null;
  }

  const keyData = parseJsonObjectString(row.key_data);
  if (!keyData) {
    return null;
  }

  return {
    id: Number(row.id),
    keyId: row.key_id,
    keyData,
  };
}

export async function markOneTimeKeyClaimed(
  db: D1Database,
  id: number,
  claimedAt: number,
): Promise<void> {
  await executeKyselyRun(
    db,
    qb.updateTable("one_time_keys").set({ claimed: 1, claimed_at: claimedAt }).where("id", "=", id),
  );
}

export async function findFallbackKey(
  db: D1Database,
  userId: string,
  deviceId: string,
  algorithm: string,
): Promise<FederationClaimedOneTimeKeyRecord | null> {
  const row = await executeKyselyQueryFirst<Pick<FallbackKeyRow, "key_id" | "key_data">>(
    db,
    qb
      .selectFrom("fallback_keys")
      .select(["key_id", "key_data"])
      .where("user_id", "=", userId)
      .where("device_id", "=", deviceId)
      .where("algorithm", "=", algorithm),
  );

  if (!row) {
    return null;
  }

  const keyData = parseJsonObjectString(row.key_data);
  if (!keyData) {
    return null;
  }

  return {
    keyId: row.key_id,
    keyData,
  };
}

export async function markFallbackKeyUsed(
  db: D1Database,
  userId: string,
  deviceId: string,
  algorithm: string,
): Promise<void> {
  await executeKyselyRun(
    db,
    qb
      .updateTable("fallback_keys")
      .set({ used: 1 })
      .where("user_id", "=", userId)
      .where("device_id", "=", deviceId)
      .where("algorithm", "=", algorithm),
  );
}
