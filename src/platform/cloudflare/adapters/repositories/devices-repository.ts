import {
  createKyselyBuilder,
  executeKyselyBatch,
  executeKyselyQuery,
  executeKyselyQueryFirst,
  executeKyselyRun,
  type CompiledQuery,
} from "../db/kysely";
import type { UserId } from "../../../../fatrix-model/types";
import type { DeviceRecord } from "../../../../fatrix-backend/application/features/devices/types";

const LOCAL_NOTIFICATION_SETTINGS_PREFIX = "org.matrix.msc3890.local_notification_settings.";

interface DeviceRow {
  user_id: string;
  device_id: string;
  display_name: string | null;
  last_seen_ts: number | null;
  last_seen_ip: string | null;
}

interface AccessTokenRow {
  user_id: string;
  token_hash: string;
  device_id: string | null;
}

interface AccountDataRow {
  user_id: string;
  room_id: string;
  event_type: string;
  content: string;
  deleted: number;
}

interface DevicesDatabase {
  devices: DeviceRow;
  access_tokens: AccessTokenRow;
  account_data: AccountDataRow;
}

const qb = createKyselyBuilder<DevicesDatabase>();

function toDeviceRecord(
  row: Pick<DeviceRow, "device_id" | "display_name" | "last_seen_ts" | "last_seen_ip">,
): DeviceRecord {
  return {
    deviceId: row.device_id,
    displayName: row.display_name,
    lastSeenTs: row.last_seen_ts,
    lastSeenIp: row.last_seen_ip,
  };
}

function buildMarkNotificationSettingsDeletedQuery(
  userId: UserId,
  deviceId: string,
): CompiledQuery {
  return qb
    .insertInto("account_data")
    .values({
      user_id: userId,
      room_id: "",
      event_type: `${LOCAL_NOTIFICATION_SETTINGS_PREFIX}${deviceId}`,
      content: "{}",
      deleted: 1,
    })
    .onConflict((oc) =>
      oc.columns(["user_id", "room_id", "event_type"]).doUpdateSet({
        content: "{}",
        deleted: 1,
      }),
    );
}

export async function listDevicesForUser(db: D1Database, userId: UserId): Promise<DeviceRecord[]> {
  const rows = await executeKyselyQuery<
    Pick<DeviceRow, "device_id" | "display_name" | "last_seen_ts" | "last_seen_ip">
  >(
    db,
    qb
      .selectFrom("devices")
      .select(["device_id", "display_name", "last_seen_ts", "last_seen_ip"])
      .where("user_id", "=", userId),
  );

  return rows.map((row) => toDeviceRecord(row));
}

export async function findDeviceForUser(
  db: D1Database,
  userId: UserId,
  deviceId: string,
): Promise<DeviceRecord | null> {
  const row = await executeKyselyQueryFirst<
    Pick<DeviceRow, "device_id" | "display_name" | "last_seen_ts" | "last_seen_ip">
  >(
    db,
    qb
      .selectFrom("devices")
      .select(["device_id", "display_name", "last_seen_ts", "last_seen_ip"])
      .where("user_id", "=", userId)
      .where("device_id", "=", deviceId)
      .limit(1),
  );

  return row ? toDeviceRecord(row) : null;
}

export function updateDeviceDisplayName(
  db: D1Database,
  userId: UserId,
  deviceId: string,
  displayName: string | null,
): Promise<void> {
  return executeKyselyRun(
    db,
    qb
      .updateTable("devices")
      .set({ display_name: displayName })
      .where("user_id", "=", userId)
      .where("device_id", "=", deviceId),
  );
}

export function deleteAccessTokensForDevice(
  db: D1Database,
  userId: UserId,
  deviceId: string,
): Promise<void> {
  return executeKyselyRun(
    db,
    qb.deleteFrom("access_tokens").where("user_id", "=", userId).where("device_id", "=", deviceId),
  );
}

export async function deleteDeviceForUser(
  db: D1Database,
  userId: UserId,
  deviceId: string,
): Promise<void> {
  await executeKyselyBatch(db, [
    buildMarkNotificationSettingsDeletedQuery(userId, deviceId),
    qb.deleteFrom("devices").where("user_id", "=", userId).where("device_id", "=", deviceId),
  ]);
}

export async function deleteDevicesForUser(
  db: D1Database,
  userId: UserId,
  deviceIds: readonly string[],
): Promise<void> {
  for (const deviceId of deviceIds) {
    await deleteAccessTokensForDevice(db, userId, deviceId);
    await deleteDeviceForUser(db, userId, deviceId);
  }
}
