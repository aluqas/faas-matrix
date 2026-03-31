export type JsonObject = Record<string, unknown>;

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

function isPlainObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseJsonObject(value: unknown): JsonObject | null {
  return isPlainObject(value) ? value : null;
}

export function parseJsonObjectString(value: string | null | undefined): JsonObject | undefined {
  if (!value) {
    return undefined;
  }

  try {
    return parseJsonObject(JSON.parse(value)) ?? undefined;
  } catch {
    return undefined;
  }
}

function parsePushAction(value: unknown): PushAction | null {
  if (typeof value === "string") {
    return value;
  }

  if (!isPlainObject(value)) {
    return null;
  }

  const setTweak = value["set_tweak"];
  if (typeof setTweak !== "string") {
    return null;
  }

  return {
    ...value,
    set_tweak: setTweak,
  };
}

export function parsePushActions(value: unknown): PushAction[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const entries = value.map((entry) => parsePushAction(entry));
  if (entries.some((entry) => entry === null)) {
    return null;
  }

  return entries as PushAction[];
}

function parsePushCondition(value: unknown): PushCondition | null {
  if (!isPlainObject(value)) {
    return null;
  }

  const kind = value["kind"];
  const key = value["key"];
  const pattern = value["pattern"];
  const isValue = value["is"];

  if (
    typeof kind !== "string" ||
    (key !== undefined && typeof key !== "string") ||
    (pattern !== undefined && typeof pattern !== "string") ||
    (isValue !== undefined && typeof isValue !== "string")
  ) {
    return null;
  }

  return {
    ...value,
    kind,
    ...(key !== undefined ? { key } : {}),
    ...(pattern !== undefined ? { pattern } : {}),
    ...(isValue !== undefined ? { is: isValue } : {}),
  };
}

export function parsePushConditions(value: unknown): PushCondition[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const entries = value.map((entry) => parsePushCondition(entry));
  if (entries.some((entry) => entry === null)) {
    return null;
  }

  return entries as PushCondition[];
}

export function parsePusherData(value: unknown): PusherData | null {
  if (!isPlainObject(value)) {
    return null;
  }

  const url = value["url"];
  const format = value["format"];
  const defaultPayload = value["default_payload"];

  if (
    (url !== undefined && typeof url !== "string") ||
    (format !== undefined && typeof format !== "string") ||
    (defaultPayload !== undefined && !isPlainObject(defaultPayload))
  ) {
    return null;
  }

  return {
    ...value,
    ...(url !== undefined ? { url } : {}),
    ...(format !== undefined ? { format } : {}),
    ...(defaultPayload !== undefined ? { default_payload: defaultPayload } : {}),
  };
}

export function parsePusherRequestBody(value: unknown): PusherRequestBody | null {
  if (!isPlainObject(value)) {
    return null;
  }

  const pushkey = value["pushkey"];
  const kind = value["kind"];
  const appId = value["app_id"];
  const appDisplayName = value["app_display_name"];
  const deviceDisplayName = value["device_display_name"];
  const profileTag = value["profile_tag"];
  const lang = value["lang"];
  const data = value["data"];
  const append = value["append"];
  const parsedData = data === undefined ? undefined : parsePusherData(data);

  if (
    (pushkey !== undefined && typeof pushkey !== "string") ||
    (kind !== undefined && kind !== null && typeof kind !== "string") ||
    (appId !== undefined && typeof appId !== "string") ||
    (appDisplayName !== undefined && typeof appDisplayName !== "string") ||
    (deviceDisplayName !== undefined && typeof deviceDisplayName !== "string") ||
    (profileTag !== undefined && typeof profileTag !== "string") ||
    (lang !== undefined && typeof lang !== "string") ||
    (data !== undefined && !parsedData) ||
    (append !== undefined && typeof append !== "boolean")
  ) {
    return null;
  }

  return {
    ...(pushkey !== undefined ? { pushkey } : {}),
    ...(kind !== undefined ? { kind: kind as string | null } : {}),
    ...(appId !== undefined ? { app_id: appId } : {}),
    ...(appDisplayName !== undefined ? { app_display_name: appDisplayName } : {}),
    ...(deviceDisplayName !== undefined ? { device_display_name: deviceDisplayName } : {}),
    ...(profileTag !== undefined ? { profile_tag: profileTag } : {}),
    ...(lang !== undefined ? { lang } : {}),
    ...(parsedData ? { data: parsedData } : {}),
    ...(append !== undefined ? { append } : {}),
  };
}

export function parsePushRuleUpsertRequest(value: unknown): PushRuleUpsertRequest | null {
  if (!isPlainObject(value)) {
    return null;
  }

  const actions = parsePushActions(value["actions"]);
  const conditions =
    value["conditions"] === undefined ? undefined : parsePushConditions(value["conditions"]);
  const pattern = value["pattern"];

  if (
    !actions ||
    (value["conditions"] !== undefined && !conditions) ||
    (pattern !== undefined && typeof pattern !== "string")
  ) {
    return null;
  }

  return {
    actions,
    ...(conditions ? { conditions } : {}),
    ...(typeof pattern === "string" ? { pattern } : {}),
  };
}

export function parsePushRuleEnabledRequest(value: unknown): PushRuleEnabledRequest | null {
  if (!isPlainObject(value) || typeof value["enabled"] !== "boolean") {
    return null;
  }

  return { enabled: value["enabled"] };
}

export function parsePushRuleActionsRequest(value: unknown): PushRuleActionsRequest | null {
  if (!isPlainObject(value)) {
    return null;
  }

  const actions = parsePushActions(value["actions"]);
  return actions ? { actions } : null;
}

export function parsePushActionsJson(value: string | null | undefined): PushAction[] | undefined {
  if (!value) {
    return undefined;
  }

  try {
    return parsePushActions(JSON.parse(value)) ?? undefined;
  } catch {
    return undefined;
  }
}

export function parsePushConditionsJson(
  value: string | null | undefined,
): PushCondition[] | undefined {
  if (!value) {
    return undefined;
  }

  try {
    return parsePushConditions(JSON.parse(value)) ?? undefined;
  } catch {
    return undefined;
  }
}

export function parsePusherDataJson(value: string | null | undefined): PusherData | undefined {
  if (!value) {
    return undefined;
  }

  try {
    return parsePusherData(JSON.parse(value)) ?? undefined;
  } catch {
    return undefined;
  }
}
