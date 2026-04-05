import type { JsonObject } from "./common";

export type { JsonObject };

export interface DeviceKeysPayload extends JsonObject {
  user_id?: string;
  device_id?: string;
  unsigned?: JsonObject;
  algorithms?: string[];
  keys?: Record<string, string>;
  signatures?: Record<string, Record<string, string>>;
}

export interface CrossSigningKeyPayload extends JsonObject {
  user_id?: string;
  usage?: string[];
  keys?: Record<string, string>;
  signatures?: Record<string, Record<string, string>>;
}

export interface UIAAuthDict extends JsonObject {
  type?: string;
  session?: string;
  password?: string;
}

export interface KeysUploadRequest {
  device_keys?: DeviceKeysPayload;
  one_time_keys?: Record<string, JsonObject>;
  fallback_keys?: Record<string, JsonObject>;
}

export interface KeysQueryRequest {
  device_keys?: Record<string, string[]>;
}

export interface KeysQueryResponse {
  device_keys: Record<string, Record<string, DeviceKeysPayload>>;
  master_keys?: Record<string, CrossSigningKeyPayload>;
  self_signing_keys?: Record<string, CrossSigningKeyPayload>;
  user_signing_keys?: Record<string, CrossSigningKeyPayload>;
}

export interface KeysClaimRequest {
  one_time_keys?: Record<string, Record<string, string>>;
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

export interface SignedKeyPayload extends JsonObject {
  device_id?: string;
  signatures?: Record<string, Record<string, string>>;
}

export type SignaturesUploadRequest = Record<string, Record<string, SignedKeyPayload>>;

export interface TokenSubmitRequest {
  session?: string;
}

export interface UiaSessionData extends JsonObject {
  user_id: string;
  created_at: number;
  type: string;
  completed_stages: string[];
  is_oidc_user?: boolean;
  has_password?: boolean;
  redirect_url?: string;
  sso_completed_at?: number;
  token_completed_at?: number;
}

export interface StoredOneTimeKey {
  keyId: string;
  keyData: JsonObject;
  claimed: boolean;
}

export type StoredOneTimeKeyBuckets = Record<string, StoredOneTimeKey[]>;

export interface PushActionObject extends JsonObject {
  set_tweak: string;
  value?: unknown;
}

export type PushAction = string | PushActionObject;

export interface PushCondition extends JsonObject {
  kind: string;
  key?: string;
  pattern?: string;
  is?: string;
  value?: unknown;
}

export interface PushRule {
  rule_id: string;
  default: boolean;
  enabled: boolean;
  conditions?: PushCondition[];
  actions: PushAction[];
  pattern?: string;
}

export interface PushEvent {
  event_id: string;
  room_id: string;
  type: string;
  sender: string;
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

export interface PusherData extends JsonObject {
  url?: string;
  format?: string;
  default_payload?: JsonObject;
}

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
