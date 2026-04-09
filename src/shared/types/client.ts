import type { JsonObject, JsonValue } from "./common";
import type {
  DeviceId,
  EventId,
  EventType,
  MatrixSignatures,
  RoomId,
  ServerName,
  UserId,
} from "./matrix";

export type { JsonObject };

export type StringMap = Record<string, string>;
export type JsonObjectMap = Record<string, JsonObject>;
export type DeviceListRequest = Array<DeviceId>;
export type DeviceKeyRequestMap = Record<UserId, DeviceListRequest>;
export type OneTimeKeyClaimDeviceMap = Record<DeviceId, string>;
export type OneTimeKeyClaimMap = Record<UserId, OneTimeKeyClaimDeviceMap>;
export type UserDeviceKeysMap = Record<UserId, Record<DeviceId, DeviceKeysPayload>>;
export type UserCrossSigningKeyMap = Record<UserId, CrossSigningKeyPayload>;
export type DeviceOneTimeKeysMap = Record<DeviceId, JsonObjectMap>;
export type UserOneTimeKeysMap = Record<UserId, DeviceOneTimeKeysMap>;

export type DeviceKeysPayload = JsonObject & {
  user_id?: UserId;
  device_id?: DeviceId;
  unsigned?: JsonObject;
  algorithms?: string[];
  keys?: StringMap;
  signatures?: MatrixSignatures;
};

export type CrossSigningKeyPayload = JsonObject & {
  user_id?: UserId;
  usage?: string[];
  keys?: StringMap;
  signatures?: MatrixSignatures;
};

export type UIAAuthDict = JsonObject & {
  type?: string;
  session?: string;
  password?: string;
};

export interface KeysUploadRequest {
  device_keys?: DeviceKeysPayload;
  one_time_keys?: JsonObjectMap;
  fallback_keys?: JsonObjectMap;
}

export interface KeysQueryRequest {
  device_keys?: DeviceKeyRequestMap;
}

export interface KeysQueryResponse {
  device_keys: UserDeviceKeysMap;
  master_keys?: UserCrossSigningKeyMap;
  self_signing_keys?: UserCrossSigningKeyMap;
  user_signing_keys?: UserCrossSigningKeyMap;
}

export interface KeysClaimRequest {
  one_time_keys?: OneTimeKeyClaimMap;
}

export interface CrossSigningUploadRequest {
  master_key?: CrossSigningKeyPayload;
  self_signing_key?: CrossSigningKeyPayload;
  user_signing_key?: CrossSigningKeyPayload;
  auth?: UIAAuthDict;
}

export interface CrossSigningKeysStore {
  master?: CrossSigningKeyPayload;
  self_signing?: CrossSigningKeyPayload;
  user_signing?: CrossSigningKeyPayload;
}

export type SignedKeyPayload = JsonObject & {
  device_id?: DeviceId;
  signatures?: MatrixSignatures;
};

export type SignaturesUploadRequest = Record<UserId, Record<string, SignedKeyPayload>>;

export interface TokenSubmitRequest {
  session?: string;
}

export type UiaSessionData = JsonObject & {
  user_id: UserId;
  created_at: number;
  type: string;
  completed_stages: string[];
  is_oidc_user?: boolean;
  has_password?: boolean;
  redirect_url?: string;
  sso_completed_at?: number;
  token_completed_at?: number;
};

export interface StoredOneTimeKey {
  keyId: string;
  keyData: JsonObject;
  claimed: boolean;
}

export type StoredOneTimeKeyBuckets = Record<string, StoredOneTimeKey[]>;

export type PushActionObject = JsonObject & {
  set_tweak: string;
  value?: unknown;
};

export type PushAction = string | PushActionObject;

export type PushCondition = JsonObject & {
  kind: string;
  key?: string;
  pattern?: string;
  is?: string;
  value?: unknown;
};

export interface PushRule {
  rule_id: string;
  default: boolean;
  enabled: boolean;
  conditions?: PushCondition[];
  actions: PushAction[];
  pattern?: string;
}

export interface PushEvent {
  event_id: EventId;
  room_id: RoomId;
  type: EventType;
  sender: UserId;
  content: JsonObject;
  origin_server_ts?: number;
  state_key?: string;
  sender_display_name?: string;
  room_name?: string;
}

export interface PushNotificationCounts {
  unread: number;
  missed_calls?: number;
}

export interface PushEvaluationResult {
  notify: boolean;
  actions: PushAction[];
  highlight: boolean;
}

export type PusherData = JsonObject & {
  url?: string;
  format?: string;
  default_payload?: JsonObject;
};

export interface PusherRequestBody {
  pushkey?: string;
  kind?: string | null;
  app_id?: string;
  app_display_name?: string;
  device_display_name?: string;
  profile_tag?: string;
  lang?: string;
  data?: PusherData;
  append?: boolean;
}

export interface PushRuleUpsertRequest {
  actions: PushAction[];
  conditions?: PushCondition[];
  pattern?: string;
}

export interface PushRuleEnabledRequest {
  enabled: boolean;
}

export interface PushRuleActionsRequest {
  actions: PushAction[];
}

export interface BackupAlgorithmData {
  public_key: string;
  signatures?: MatrixSignatures;
}

export interface CreateBackupRequest {
  algorithm: string;
  auth_data: BackupAlgorithmData;
}

export interface BackupVersionResponse {
  algorithm: string;
  auth_data: BackupAlgorithmData;
  count: number;
  etag: string;
  version: string;
}

export interface KeyBackupData {
  first_message_index: number;
  forwarded_count: number;
  is_verified: boolean;
  session_data: JsonObject | JsonValue;
}

export type RoomKeyBackupSessions = Record<string, KeyBackupData>;

export interface RoomKeyBackup {
  sessions: RoomKeyBackupSessions;
}

export type KeysBackupRooms = Record<string, RoomKeyBackup>;

export interface KeysBackupRequest {
  rooms: KeysBackupRooms;
}

export interface OpenIDToken {
  access_token: string;
  token_type: string;
  matrix_server_name: ServerName;
  expires_in: number;
}

export interface MemberInfo {
  id: string;
  claimed_user_id: UserId;
  claimed_device_id: DeviceId;
}

export interface GetTokenRequest {
  room_id?: RoomId;
  room?: RoomId;
  slot_id?: string;
  openid_token: OpenIDToken;
  member?: MemberInfo;
  device_id?: DeviceId;
  delayed_event_id?: EventId;
}

export interface GetTokenResponse {
  url: string;
  jwt: string;
}

export interface SearchRoomEventsFilter {
  limit?: number;
  rooms?: RoomId[];
  not_rooms?: RoomId[];
  senders?: UserId[];
  not_senders?: UserId[];
  types?: EventType[];
  not_types?: EventType[];
}

export interface SearchEventContextRequest {
  before_limit?: number;
  after_limit?: number;
  include_profile?: boolean;
}

export interface SearchGroupingKey {
  key: string;
}

export interface SearchGroupingsRequest {
  group_by: SearchGroupingKey[];
}

export interface SearchRoomEventsRequest {
  search_term: string;
  keys?: string[];
  filter?: SearchRoomEventsFilter;
  order_by?: "recent" | "rank";
  event_context?: SearchEventContextRequest;
  include_state?: boolean;
  groupings?: SearchGroupingsRequest;
}

export interface SearchRequest {
  search_categories: {
    room_events?: SearchRoomEventsRequest;
  };
}

export interface SearchResultEvent {
  event_id: EventId;
  type: EventType;
  room_id: RoomId;
  sender: UserId;
  origin_server_ts: number;
  content: JsonObject;
}

export interface SearchProfileInfo {
  displayname?: string;
  avatar_url?: string;
}

export interface SearchResultContext {
  events_before: SearchResultEvent[];
  events_after: SearchResultEvent[];
  profile_info?: Record<UserId, SearchProfileInfo>;
  start?: string;
  end?: string;
}

export interface SearchResultEntry {
  event_id: EventId;
  rank: number;
  result: SearchResultEvent;
  context?: SearchResultContext;
}

export interface ContentReportRecord {
  id: number;
  reporter_user_id: UserId;
  room_id: RoomId;
  event_id: EventId;
  reason: string;
  score: number;
  created_at: number;
  resolved: boolean;
  resolved_by?: UserId;
  resolved_at?: number;
  resolution_note?: string;
}

export interface ToDeviceRequest {
  messages: Record<UserId, Record<DeviceId, Record<string, unknown>>>;
}

export interface IdPProvider {
  id: string;
  name: string;
  issuer_url: string;
  client_id: string;
  client_secret_encrypted: string;
  scopes: string;
  enabled: number;
  auto_create_users: number;
  username_claim: string;
  display_order: number;
  icon_url: string | null;
}

export interface AdminIdPProvider extends IdPProvider {
  created_at: number;
  updated_at: number;
}

export interface IdPUserLink {
  id: number;
  provider_id: string;
  external_id: string;
  user_id: UserId;
  external_email: string | null;
  external_name: string | null;
}

export interface OAuthState {
  providerId: string;
  nonce: string;
  redirectUri: string;
  returnTo?: string;
}

export interface OAuthClient {
  client_id: string;
  client_secret_hash: string | null;
  client_name: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: string;
  created_at: number;
}

export interface AuthorizationCode {
  code: string;
  client_id: string;
  user_id: UserId;
  redirect_uri: string;
  scope: string;
  code_challenge?: string;
  code_challenge_method?: string;
  nonce?: string;
  created_at: number;
  expires_at: number;
}

export interface OAuthToken {
  token_id: string;
  access_token_hash: string;
  refresh_token_hash?: string;
  client_id: string;
  user_id: UserId;
  device_id: DeviceId;
  scope: string;
  created_at: number;
  expires_at: number;
}

export interface SpaceHierarchyChildStateEvent {
  type: "m.space.child";
  state_key: RoomId;
  content: Record<string, unknown>;
  sender: UserId;
  origin_server_ts: number;
}

export interface SpaceHierarchyRoomSummary {
  room_id: RoomId;
  room_type?: string;
  name?: string;
  topic?: string;
  canonical_alias?: string;
  num_joined_members: number;
  avatar_url?: string;
  join_rule?: string;
  world_readable: boolean;
  guest_can_join: boolean;
}

export type PublicRoomSummary = SpaceHierarchyRoomSummary;

export interface SpaceHierarchyRoom extends SpaceHierarchyRoomSummary {
  children_state: SpaceHierarchyChildStateEvent[];
}

export interface FederationSpaceHierarchyRoom extends SpaceHierarchyRoomSummary {
  children_state?: Array<{
    type?: unknown;
    state_key?: unknown;
    content?: unknown;
    sender?: unknown;
    origin_server_ts?: unknown;
  }>;
}

export interface FederationSpaceHierarchyResponse {
  room?: FederationSpaceHierarchyRoom | null;
}

export interface SpaceHierarchySnapshot {
  room: SpaceHierarchyRoom;
  childEdges: SpaceHierarchyChildEdge[];
}

export interface SpaceHierarchyChildEdge {
  roomId: RoomId;
  content: Record<string, unknown>;
}

export interface ThreadSubscriptionState {
  automatic: boolean;
  subscribed: boolean;
  unsubscribed_after?: number;
  automatic_event_id?: EventId;
}

export interface SlidingSyncToDeviceExtensionConfig {
  enabled?: boolean;
  since?: string;
  limit?: number;
}

export interface SlidingSyncToggleExtensionConfig {
  enabled?: boolean;
}

export interface SlidingSyncRoomScopedExtensionConfig {
  enabled?: boolean;
  lists?: string[];
  rooms?: RoomId[];
}

export interface SlidingSyncThreadSubscriptionsExtensionConfig {
  enabled?: boolean;
  limit?: number;
  rooms?: RoomId[];
}

export interface SlidingSyncExtensionConfig {
  to_device?: SlidingSyncToDeviceExtensionConfig;
  e2ee?: SlidingSyncToggleExtensionConfig;
  account_data?: SlidingSyncRoomScopedExtensionConfig;
  typing?: SlidingSyncRoomScopedExtensionConfig;
  receipts?: SlidingSyncRoomScopedExtensionConfig;
  presence?: SlidingSyncToggleExtensionConfig;
  "io.element.msc4308.thread_subscriptions"?: SlidingSyncThreadSubscriptionsExtensionConfig;
}
