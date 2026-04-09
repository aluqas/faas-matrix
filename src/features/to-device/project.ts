import { loadToDeviceMessagesBatch } from "../../infra/repositories/to-device-repository";
import type { ToDeviceBatch } from "./contracts";

export function projectToDeviceMessages(
  db: D1Database,
  userId: string,
  deviceId: string,
  since?: string,
  limit: number = 100,
): Promise<ToDeviceBatch> {
  return loadToDeviceMessagesBatch(
    db,
    userId as import("../../shared/types").UserId,
    deviceId,
    since,
    limit,
  );
}
