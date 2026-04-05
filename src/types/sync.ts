import type { SyncResponse } from "./matrix";
import type { PresenceSyncProjection } from "./presence";
import type { FilterDefinition } from "../matrix/repositories/interfaces";
import type { InvitedRoom, KnockedRoom, LeftRoom } from "./matrix";
import type { SlidingSyncExtensionConfig } from "./client";
import type { Env } from "./env";

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

export interface SlidingSyncRequest {
  conn_id?: string;
  pos?: string;
  txn_id?: string;
  timeout?: number;
  delta_token?: string;
  lists?: Record<string, SyncListConfig>;
  room_subscriptions?: Record<string, RoomSubscription>;
  unsubscribe_rooms?: string[];
  extensions?: SlidingSyncExtensionConfig;
}

export interface SyncListConfig {
  ranges?: [number, number][];
  range?: [number, number];
  sort?: string[];
  required_state?: [string, string][];
  timeline_limit?: number;
  filters?: SlidingRoomFilter;
  bump_event_types?: string[];
}

export interface RoomSubscription {
  required_state?: [string, string][];
  timeline_limit?: number;
  include_old_rooms?: {
    timeline_limit?: number;
    required_state?: [string, string][];
  };
}

export interface SlidingRoomFilter {
  is_dm?: boolean;
  spaces?: string[];
  is_encrypted?: boolean;
  is_invite?: boolean;
  is_tombstoned?: boolean;
  room_types?: string[];
  not_room_types?: string[];
  room_name_like?: string;
  tags?: string[];
  not_tags?: string[];
}

export interface SlidingSyncResponse {
  pos: string;
  txn_id?: string;
  lists: Record<string, SyncListResult>;
  rooms: Record<string, RoomResult>;
  extensions: ExtensionsResponse;
  delta_token?: string;
}

export interface SyncListResult {
  count: number;
  ops?: RoomListOperation[];
}

export interface RoomListOperation {
  op: "SYNC" | "DELETE" | "INSERT" | "INVALIDATE";
  range?: [number, number];
  index?: number;
  room_ids?: string[];
  room_id?: string;
}

export interface RoomResult {
  name?: string;
  avatar?: string;
  topic?: string;
  canonical_alias?: string;
  heroes?: StrippedHero[];
  initial?: boolean;
  required_state?: any[];
  timeline?: any[];
  prev_batch?: string;
  limited?: boolean;
  joined_count?: number;
  invited_count?: number;
  notification_count?: number;
  highlight_count?: number;
  num_live?: number;
  timestamp?: number;
  bump_stamp?: number;
  is_dm?: boolean;
  invite_state?: any[];
  knock_state?: any[];
  membership?: string;
}

export interface StrippedHero {
  user_id: string;
  displayname?: string;
  avatar_url?: string;
}

export interface ExtensionsResponse {
  to_device?: {
    next_batch: string;
    events: any[];
  };
  e2ee?: {
    device_lists?: {
      changed: string[];
      left: string[];
    };
    device_one_time_keys_count?: Record<string, number>;
    device_unused_fallback_key_types?: string[];
  };
  account_data?: {
    global?: any[];
    rooms?: Record<string, any[]>;
  };
  typing?: {
    rooms?: Record<string, { type: string; content: { user_ids: string[] } }>;
  };
  receipts?: {
    rooms?: Record<string, any>;
  };
  presence?: {
    events?: any[];
  };
  "io.element.msc4308.thread_subscriptions"?: {
    subscribed?: Record<string, Record<string, { bump_stamp: number; automatic: boolean }>>;
  };
}

export interface SlidingSyncExtensionContext {
  userId: string;
  deviceId: string | null;
  db: D1Database;
  env: Env;
  sincePos: number;
  isInitialSync: boolean;
  responseRoomIds: string[];
  subscribedRoomIds: string[];
  visibilityContext: RoomVisibilityContext;
}

export type SlidingSyncExtensionOutput = Record<string, unknown>;
