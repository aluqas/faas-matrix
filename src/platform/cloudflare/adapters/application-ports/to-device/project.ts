import type { DeviceId, UserId } from "../../../../../fatrix-model/types";
import {
  deleteDeliveredToDeviceMessagesBefore,
  loadToDeviceMessagesBatch,
} from "../../repositories/to-device-repository";
import type { ToDeviceBatch } from "../../../../../fatrix-backend/application/features/to-device/contracts";

export function getToDeviceMessages(
  db: D1Database,
  userId: UserId,
  deviceId: DeviceId,
  since?: string,
  limit: number = 100,
): Promise<ToDeviceBatch> {
  return loadToDeviceMessagesBatch(db, userId, deviceId, since, limit);
}

export function cleanupOldToDeviceMessages(
  db: D1Database,
  maxAgeMs: number = 7 * 24 * 60 * 60 * 1000,
): Promise<number> {
  return deleteDeliveredToDeviceMessagesBefore(db, Date.now() - maxAgeMs);
}
