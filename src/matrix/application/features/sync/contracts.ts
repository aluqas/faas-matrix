import type { SyncResponse } from "../../../../types";
import type { SyncProjectionResult } from "../../sync-projection";
import type { PresenceSyncProjection } from "../presence/contracts";

/**
 * Canonical visibility boundary for a single sync response.
 *
 * Computed once per request and shared by all projection functions
 * (room-delta, presence, device-list, thread-subscriptions, etc.) so that
 * every feature sees exactly the same set of "visible rooms".
 */
export interface RoomVisibilityContext {
  /** All joined rooms visible to the user (room filter applied). */
  visibleJoinedRoomIds: string[];
  /** Rooms in partial-state that are hidden from this response (full-state only). */
  hiddenPartialStateRooms: ReadonlySet<string>;
  /** Rooms in partial-state that ARE exposed in this response (lazy-load mode). */
  visiblePartialStateRooms: ReadonlySet<string>;
  /** Rooms that must deliver a full-state snapshot this response (just-completed partial join). */
  forceFullStateRooms: ReadonlySet<string>;
}

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

export interface SyncCursor {
  events: number;
  toDevice: number;
  deviceKeys: number;
}

export interface SyncUserInput {
  userId: string;
  deviceId: string | null;
  since?: string;
  fullState?: boolean;
  filterParam?: string;
  timeout?: number;
  setPresence?: "online" | "offline" | "unavailable";
}

export interface SyncTokenPosition {
  events: number;
  toDevice: number;
  deviceKeys: number;
}

export interface SyncAssemblerInput extends SyncUserInput {}

export interface RoomDeltaResult {
  joinedRooms: NonNullable<SyncResponse["rooms"]>["join"];
}

export interface MembershipRoomsResult extends SyncProjectionResult {}

export interface TopLevelSyncResult {
  accountData: NonNullable<SyncResponse["account_data"]>["events"];
  toDeviceEvents: NonNullable<SyncResponse["to_device"]>["events"];
  deviceLists?: SyncResponse["device_lists"];
  presence: PresenceSyncProjection;
  deviceOneTimeKeysCount: NonNullable<SyncResponse["device_one_time_keys_count"]>;
  deviceUnusedFallbackKeyTypes: NonNullable<SyncResponse["device_unused_fallback_key_types"]>;
  currentToDevicePos: number;
}

export interface SyncProjectionSummary {
  joinedRoomCount: number;
  inviteRoomCount: number;
  leaveRoomCount: number;
  knockRoomCount: number;
  toDeviceCount: number;
  accountDataCount: number;
  presenceCount: number;
  deviceListChangedCount: number;
  deviceListLeftCount: number;
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
