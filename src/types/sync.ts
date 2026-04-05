import type { SyncResponse } from "./matrix";
import type { PresenceSyncProjection } from "./presence";
import type { FilterDefinition } from "../matrix/repositories/interfaces";
import type { InvitedRoom, KnockedRoom, LeftRoom } from "./matrix";

export interface RoomVisibilityContext {
  visibleJoinedRoomIds: string[];
  hiddenPartialStateRooms: ReadonlySet<string>;
  visiblePartialStateRooms: ReadonlySet<string>;
  forceFullStateRooms: ReadonlySet<string>;
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

export interface ConnectionState {
  userId: string;
  pos: number;
  lastAccess: number;
  roomStates: Record<
    string,
    {
      lastStreamOrdering: number;
      sentState: boolean;
    }
  >;
  listStates: Record<
    string,
    {
      roomIds: string[];
      count: number;
    }
  >;
  roomNotificationCounts?: Record<string, number>;
  roomFullyReadMarkers?: Record<string, string>;
  initialSyncComplete?: boolean;
  roomSentAsRead?: Record<string, boolean>;
}

export interface SyncEventFilter {
  types?: string[];
  not_types?: string[];
  senders?: string[];
  not_senders?: string[];
  limit?: number;
}

export interface SyncProjectionQuery {
  userId: string;
  sincePosition: number;
  roomFilter?: FilterDefinition["room"];
  includeLeave: boolean;
}

export interface DeviceListProjectionQuery {
  userId: string;
  isInitialSync: boolean;
  sinceEventPosition: number;
  sinceDeviceKeyPosition: number;
}

export interface SyncProjectionResult {
  inviteRooms: Record<string, InvitedRoom>;
  knockRooms: Record<string, KnockedRoom>;
  leaveRooms: Record<string, LeftRoom>;
}

export interface JoinedRoomProjectionQuery {
  userId: string;
  roomId: string;
  sincePosition: number;
  fullState?: boolean;
  roomFilter?: FilterDefinition["room"];
}
