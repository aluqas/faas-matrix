import type { AppContext } from "../../../../foundation/app-context";
import type { SyncResponse } from "../../../../types";
import { getUserPushRules } from "../../../../api/push";
import type { SyncRepository } from "../../../repositories/interfaces";
import {
  applyEventFilter,
  projectDeviceLists,
  projectGlobalAccountData,
} from "../../sync-projection";
import { projectPresenceEvents } from "../presence/project";
import type { TopLevelSyncResult } from "./contracts";

export interface TopLevelSyncPorts {
  repository: SyncRepository;
  appContext: AppContext;
}

export interface ProjectTopLevelSyncInput {
  userId: string;
  deviceId: string | null;
  roomIds: string[];
  sincePosition: number;
  sinceToDevice: number;
  sinceDeviceKeys: number;
  sinceToken?: string;
  filter?: {
    presence?: unknown;
    account_data?: unknown;
  };
}

export async function projectTopLevelSync(
  ports: TopLevelSyncPorts,
  input: ProjectTopLevelSyncInput,
): Promise<TopLevelSyncResult> {
  const isInitialSync = !input.sinceToken;
  let currentToDevicePos = input.sinceToDevice;
  let toDeviceEvents: NonNullable<SyncResponse["to_device"]>["events"] = [];
  let deviceOneTimeKeysCount: NonNullable<SyncResponse["device_one_time_keys_count"]> = {};
  let deviceUnusedFallbackKeyTypes: NonNullable<SyncResponse["device_unused_fallback_key_types"]> =
    [];

  if (input.deviceId) {
    const toDeviceResult = await ports.repository.getToDeviceMessages(
      input.userId,
      input.deviceId,
      String(input.sinceToDevice),
    );
    toDeviceEvents = toDeviceResult.events;
    currentToDevicePos = Number.parseInt(toDeviceResult.nextBatch, 10) || input.sinceToDevice;
    deviceOneTimeKeysCount = await ports.repository.getOneTimeKeyCounts(
      input.userId,
      input.deviceId,
    );
    deviceUnusedFallbackKeyTypes = await ports.repository.getUnusedFallbackKeyTypes(
      input.userId,
      input.deviceId,
    );
  }

  const deviceLists = await projectDeviceLists(ports.repository, {
    userId: input.userId,
    isInitialSync,
    sinceEventPosition: input.sincePosition,
    sinceDeviceKeyPosition: input.sinceDeviceKeys,
  });

  const accountData = await projectGlobalAccountData(
    ports.repository,
    input.userId,
    input.sincePosition,
    input.filter?.account_data as never,
    { isIncremental: !isInitialSync },
  );
  if (isInitialSync && !accountData.some((event) => event.type === "m.push_rules")) {
    accountData.push(
      ...applyEventFilter(
        [
          {
            type: "m.push_rules",
            content: await getUserPushRules(
              ports.appContext.capabilities.sql.connection as D1Database,
              input.userId,
            ),
          },
        ],
        input.filter?.account_data as never,
      ),
    );
  }

  const presence = await projectPresenceEvents(
    ports.appContext.capabilities.sql.connection as D1Database,
    ports.appContext.capabilities.kv.cache as KVNamespace | undefined,
    {
      userId: input.userId,
      visibleRoomIds: input.roomIds,
      filter: input.filter?.presence as never,
      debugEnabled: ports.appContext.profile.name === "complement",
    },
  );

  return {
    accountData,
    toDeviceEvents,
    deviceLists,
    presence,
    deviceOneTimeKeysCount,
    deviceUnusedFallbackKeyTypes,
    currentToDevicePos,
  };
}
