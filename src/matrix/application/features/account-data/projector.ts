import type { AppEnv } from "../../../../types";
import type {
  AccountDataSyncEvent,
  E2EEAccountDataMap,
} from "../../../../types/account-data";
import type { RoomId, UserId } from "../../../../types/matrix";
import {
  getGlobalAccountData,
  getRoomAccountData,
} from "../../../repositories/account-data-repository";
import { getE2EEAccountDataFromDO } from "./e2ee-gateway";

export function mergeGlobalAccountData(
  databaseEvents: AccountDataSyncEvent[],
  e2eeMap: E2EEAccountDataMap,
): AccountDataSyncEvent[] {
  const merged = new Map<string, AccountDataSyncEvent>();
  for (const event of databaseEvents) {
    merged.set(event.type, event);
  }
  for (const [eventType, content] of Object.entries(e2eeMap)) {
    merged.set(eventType, { type: eventType, content });
  }
  return [...merged.values()];
}

export async function projectGlobalAccountDataSnapshot(
  env: Pick<AppEnv["Bindings"], "DB" | "USER_KEYS">,
  userId: UserId,
  includeE2EE = true,
): Promise<AccountDataSyncEvent[]> {
  const databaseEvents = await getGlobalAccountData(env.DB, userId);
  if (!includeE2EE) {
    return databaseEvents;
  }
  const e2eeData = await getE2EEAccountDataFromDO(env, userId).catch(() => ({}));
  return mergeGlobalAccountData(databaseEvents, e2eeData);
}

export function projectRoomAccountDataSnapshot(
  env: Pick<AppEnv["Bindings"], "DB">,
  userId: UserId,
  roomId: RoomId,
): Promise<AccountDataSyncEvent[]> {
  return getRoomAccountData(env.DB, userId, roomId);
}
