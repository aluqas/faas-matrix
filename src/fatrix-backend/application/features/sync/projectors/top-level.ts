import type { RoomId, SyncResponse, UserId } from "../../../../../fatrix-model/types";
import type { SyncRepository } from "../../../../ports/repositories";
import {
  applyEventFilter,
  projectDeviceLists,
  projectGlobalAccountData,
} from "../../../orchestrators/sync-projection";
import type { PresenceProjectionPort } from "../../presence/contracts";
import type { RoomVisibilityContext, TopLevelSyncResult } from "../types/contracts";

export interface TopLevelSyncPorts {
  repository: SyncRepository;
  pushRules: {
    getUserPushRules(userId: UserId): Promise<Record<string, unknown>>;
  };
  presence: PresenceProjectionPort;
}

export interface ProjectTopLevelSyncInput {
  userId: UserId;
  deviceId: string | null;
  roomIds: RoomId[];
  /**
   * When set (e.g. from `/sync` assembler), presence scope uses
   * `visibleJoinedRoomIds` from this context — the canonical visibility boundary.
   */
  visibilityContext?: RoomVisibilityContext;
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
            content: await ports.pushRules.getUserPushRules(input.userId),
          },
        ],
        input.filter?.account_data as never,
      ),
    );
  }

  const presenceVisibleRoomIds = input.visibilityContext?.visibleJoinedRoomIds ?? input.roomIds;

  const presence = await ports.presence.projectEvents({
    userId: input.userId,
    visibleRoomIds: presenceVisibleRoomIds,
    filter: input.filter?.presence as never,
  });

  const result = {
    accountData,
    toDeviceEvents,
    presence,
    deviceOneTimeKeysCount,
    deviceUnusedFallbackKeyTypes,
    currentToDevicePos,
  };

  return deviceLists
    ? { ...result, deviceLists: deviceLists as NonNullable<TopLevelSyncResult["deviceLists"]> }
    : result;
}
