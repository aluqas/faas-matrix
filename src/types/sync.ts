import type {
  AccountDataEvent,
  DeviceId,
  EventId,
  EventType,
  EphemeralEvent,
  MatrixEvent,
  RoomId,
  RoomVersionId,
  StrippedStateEvent,
  SyncAccountDataResponse,
  SyncDeviceListsResponse,
  SyncDeviceOneTimeKeyCounts,
  SyncDeviceUnusedFallbackKeyTypes,
  SyncPresenceResponse,
  SyncResponse,
  SyncToDeviceResponse,
  ToDeviceEvent,
  UnreadNotificationCounts,
  UserId,
} from "./matrix";
import type { PresenceProjectionResult } from "./presence";
import type { FilterDefinition } from "../matrix/repositories/interfaces";
import type { InvitedRoom, KnockedRoom, LeftRoom } from "./matrix";
import type { SlidingSyncExtensionConfig } from "./client";
import type { Env } from "./env";

export interface ConnectionRoomState {
  lastStreamOrdering: number;
  sentState: boolean;
}

export interface ConnectionListState {
  roomIds: RoomId[];
  count: number;
}

export interface RoomVisibilityContext {
  visibleJoinedRoomIds: RoomId[];
  hiddenPartialStateRooms: ReadonlySet<RoomId>;
  visiblePartialStateRooms: ReadonlySet<RoomId>;
  forceFullStateRooms: ReadonlySet<RoomId>;
}

export interface SyncCursor {
  events: number;
  toDevice: number;
  deviceKeys: number;
}

export interface SyncUserInput {
  userId: UserId;
  deviceId: DeviceId | null;
  since?: string;
  fullState?: boolean;
  filterParam?: string;
  timeout?: number;
  setPresence?: "online" | "offline" | "unavailable";
}

export type SyncTokenPosition = SyncCursor;

export interface SyncAssemblerInput extends SyncUserInput {}

export interface RoomDeltaResult {
  joinedRooms: NonNullable<SyncResponse["rooms"]>["join"];
}

export interface MembershipRoomsResult extends SyncProjectionResult {}

export interface TopLevelSyncResult {
  accountData: SyncAccountDataResponse["events"];
  toDeviceEvents: SyncToDeviceResponse["events"];
  deviceLists?: SyncDeviceListsResponse;
  presence: PresenceProjectionResult;
  deviceOneTimeKeysCount: SyncDeviceOneTimeKeyCounts;
  deviceUnusedFallbackKeyTypes: SyncDeviceUnusedFallbackKeyTypes;
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
  userId: UserId;
  pos: number;
  lastAccess: number;
  roomStates: Record<RoomId, ConnectionRoomState>;
  listStates: Record<string, ConnectionListState>;
  roomNotificationCounts?: Record<RoomId, number>;
  roomFullyReadMarkers?: Record<RoomId, EventId>;
  initialSyncComplete?: boolean;
  roomSentAsRead?: Record<RoomId, boolean>;
}

export interface SyncEventFilter {
  types?: string[];
  not_types?: string[];
  senders?: string[];
  not_senders?: string[];
  limit?: number;
}

export interface SyncProjectionQuery {
  userId: UserId;
  sincePosition: number;
  roomFilter?: FilterDefinition["room"];
  includeLeave: boolean;
}

export interface DeviceListProjectionQuery {
  userId: UserId;
  isInitialSync: boolean;
  sinceEventPosition: number;
  sinceDeviceKeyPosition: number;
}

export interface SyncProjectionResult {
  inviteRooms: Record<RoomId, InvitedRoom>;
  knockRooms: Record<RoomId, KnockedRoom>;
  leaveRooms: Record<RoomId, LeftRoom>;
}

export interface JoinedRoomProjectionQuery {
  userId: UserId;
  roomId: RoomId;
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
  room_subscriptions?: Record<RoomId, RoomSubscription>;
  unsubscribe_rooms?: RoomId[];
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
  include_old_rooms?: HistoricalRoomSubscription;
}

export interface HistoricalRoomSubscription {
  timeline_limit?: number;
  required_state?: [string, string][];
}

export interface SlidingRoomFilter {
  is_dm?: boolean;
  spaces?: RoomId[];
  is_encrypted?: boolean;
  is_invite?: boolean;
  is_tombstoned?: boolean;
  room_types?: RoomVersionId[];
  not_room_types?: RoomVersionId[];
  room_name_like?: string;
  tags?: string[];
  not_tags?: string[];
}

export interface SlidingSyncResponse {
  pos: string;
  txn_id?: string;
  lists: Record<string, SyncListResult>;
  rooms: Record<RoomId, RoomResult>;
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
  room_ids?: RoomId[];
  room_id?: RoomId;
}

export interface RoomResult {
  name?: string;
  avatar?: string;
  topic?: string;
  canonical_alias?: string;
  heroes?: StrippedHero[];
  initial?: boolean;
  required_state?: MatrixEvent[];
  timeline?: MatrixEvent[];
  prev_batch?: string;
  limited?: boolean;
  joined_count?: number;
  invited_count?: number;
  notification_count?: UnreadNotificationCounts["notification_count"];
  highlight_count?: UnreadNotificationCounts["highlight_count"];
  num_live?: number;
  timestamp?: number;
  bump_stamp?: number;
  is_dm?: boolean;
  invite_state?: StrippedStateEvent[];
  knock_state?: StrippedStateEvent[];
  membership?: string;
}

export interface StrippedHero {
  user_id: UserId;
  displayname?: string;
  avatar_url?: string;
}

export interface SlidingSyncToDeviceExtension {
  next_batch: string;
  events: ToDeviceEvent[];
}

export interface SlidingSyncE2eeExtension {
  device_lists?: {
    changed: NonNullable<SyncDeviceListsResponse["changed"]>;
    left: NonNullable<SyncDeviceListsResponse["left"]>;
  };
  device_one_time_keys_count?: SyncDeviceOneTimeKeyCounts;
  device_unused_fallback_key_types?: SyncDeviceUnusedFallbackKeyTypes;
}

export interface SlidingSyncAccountDataExtension {
  global?: AccountDataEvent[];
  rooms?: Record<RoomId, AccountDataEvent[]>;
}

export interface SlidingSyncTypingExtension {
  rooms?: Record<RoomId, EphemeralEvent>;
}

export interface SlidingSyncReceiptsExtension {
  rooms?: Record<RoomId, EphemeralEvent>;
}

export interface SlidingSyncPresenceExtension {
  events?: SyncPresenceResponse["events"];
}

export interface SlidingSyncThreadSubscriptionEntry {
  bump_stamp: number;
  automatic: boolean;
}

export interface SlidingSyncThreadSubscriptionsExtension {
  subscribed?: Record<RoomId, Record<EventId, SlidingSyncThreadSubscriptionEntry>>;
}

export interface ExtensionsResponse {
  to_device?: SlidingSyncToDeviceExtension;
  e2ee?: SlidingSyncE2eeExtension;
  account_data?: SlidingSyncAccountDataExtension;
  typing?: SlidingSyncTypingExtension;
  receipts?: SlidingSyncReceiptsExtension;
  presence?: SlidingSyncPresenceExtension;
  "io.element.msc4308.thread_subscriptions"?: SlidingSyncThreadSubscriptionsExtension;
}

export interface SlidingSyncExtensionContext {
  userId: UserId;
  deviceId: DeviceId | null;
  db: D1Database;
  env: Env;
  sincePos: number;
  isInitialSync: boolean;
  responseRoomIds: RoomId[];
  subscribedRoomIds: RoomId[];
  visibilityContext: RoomVisibilityContext;
}

export type SlidingSyncExtensionOutput = Partial<ExtensionsResponse>;
