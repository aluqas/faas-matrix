import {
  getNextNamedStreamPosition,
  recordDeviceKeyChangeEntry,
} from "../repositories/to-device-repository";

export function getNextStreamPosition(db: D1Database, streamName: string): Promise<number> {
  return getNextNamedStreamPosition(db, streamName);
}

export async function recordDeviceKeyChange(
  db: D1Database,
  userId: string,
  deviceId: string | null,
  changeType: string,
): Promise<void> {
  await recordDeviceKeyChangeEntry(
    db,
    userId as import("../../shared/types").UserId,
    deviceId,
    changeType,
  );
}
