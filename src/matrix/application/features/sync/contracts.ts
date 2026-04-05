import type {
  RoomVisibilityContext,
  SyncProjectionSummary,
  SyncTokenPosition,
} from "../../../../types/sync";
import type {
  MembershipRoomsResult,
  RoomDeltaResult,
  SyncAssemblerInput,
  SyncCursor,
  SyncUserInput,
  TopLevelSyncResult,
} from "../../../../types/sync";
import type { SyncResponse } from "../../../../types";

export type {
  MembershipRoomsResult,
  RoomDeltaResult,
  RoomVisibilityContext,
  SyncAssemblerInput,
  SyncCursor,
  SyncProjectionSummary,
  SyncTokenPosition,
  SyncUserInput,
  TopLevelSyncResult,
};

/**
 * Canonical visibility boundary for a single sync response.
 *
 * Computed once per request and shared by all projection functions
 * (room-delta, presence, device-list, thread-subscriptions, etc.) so that
 * every feature sees exactly the same set of "visible rooms".
 */
/** Minimal visibility context for sliding-sync, which has no partial-state concept yet. */
export function buildSlidingSyncVisibilityContext(
  allJoinedRoomIds: string[],
): RoomVisibilityContext {
  return {
    visibleJoinedRoomIds: allJoinedRoomIds,
    hiddenPartialStateRooms: new Set(),
    visiblePartialStateRooms: new Set(),
    forceFullStateRooms: new Set(),
  };
}

export function parseSyncToken(token: string | undefined): SyncTokenPosition {
  if (!token) {
    return { events: 0, toDevice: 0, deviceKeys: 0 };
  }

  const match = token.match(/^s(\d+)_td(\d+)(?:_dk(\d+))?$/);
  if (match) {
    const events = Number.parseInt(match[1] ?? "0", 10);
    const toDevice = Number.parseInt(match[2] ?? "0", 10);
    return {
      events,
      toDevice,
      deviceKeys: Number.parseInt(match[3] ?? String(events), 10),
    };
  }

  const fallback = Number.parseInt(token, 10);
  if (!Number.isNaN(fallback)) {
    return { events: fallback, toDevice: fallback, deviceKeys: fallback };
  }

  return { events: 0, toDevice: 0, deviceKeys: 0 };
}

export function buildSyncToken(
  eventsPos: number,
  toDevicePos: number,
  deviceKeyPos: number,
): string {
  return `s${eventsPos}_td${toDevicePos}_dk${deviceKeyPos}`;
}

export function summarizeSyncResponse(response: SyncResponse): SyncProjectionSummary {
  return {
    joinedRoomCount: Object.keys(response.rooms?.join ?? {}).length,
    inviteRoomCount: Object.keys(response.rooms?.invite ?? {}).length,
    leaveRoomCount: Object.keys(response.rooms?.leave ?? {}).length,
    knockRoomCount: Object.keys(response.rooms?.knock ?? {}).length,
    toDeviceCount: response.to_device?.events.length ?? 0,
    accountDataCount: response.account_data?.events.length ?? 0,
    presenceCount: response.presence?.events.length ?? 0,
    deviceListChangedCount: response.device_lists?.changed?.length ?? 0,
    deviceListLeftCount: response.device_lists?.left?.length ?? 0,
  };
}
