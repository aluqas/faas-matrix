import type {
  JsonObject,
  PushAction,
  PushCondition,
  PusherData,
  PusherRequestBody,
  PushEvaluationResult,
  PushEvent,
  PushNotificationCounts,
  PushRule,
  PushRuleActionsRequest,
  PushRuleEnabledRequest,
  PushRuleUpsertRequest,
} from "../shared/types/client";

export type {
  JsonObject,
  PushAction,
  PushCondition,
  PusherData,
  PusherRequestBody,
  PushEvaluationResult,
  PushEvent,
  PushNotificationCounts,
  PushRule,
  PushRuleActionsRequest,
  PushRuleEnabledRequest,
  PushRuleUpsertRequest,
};

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

  const record = value as Record<string, unknown>;
  const setTweak = record["set_tweak"];
  if (typeof setTweak !== "string") {
    return null;
  }

  return {
    set_tweak: setTweak,
    ...(record["value"] !== undefined ? { value: record["value"] } : {}),
  } as PushAction;
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

  const record = value as Record<string, unknown>;
  const kind = record["kind"];
  const key = record["key"];
  const pattern = record["pattern"];
  const isValue = record["is"];

  if (
    typeof kind !== "string" ||
    (key !== undefined && typeof key !== "string") ||
    (pattern !== undefined && typeof pattern !== "string") ||
    (isValue !== undefined && typeof isValue !== "string")
  ) {
    return null;
  }

  return {
    kind,
    ...(key !== undefined ? { key } : {}),
    ...(pattern !== undefined ? { pattern } : {}),
    ...(isValue !== undefined ? { is: isValue } : {}),
    ...(record["value"] !== undefined ? { value: record["value"] } : {}),
  } as PushCondition;
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

  const record = value as Record<string, unknown>;
  const url = record["url"];
  const format = record["format"];
  const defaultPayload = record["default_payload"];

  if (
    (url !== undefined && typeof url !== "string") ||
    (format !== undefined && typeof format !== "string") ||
    (defaultPayload !== undefined && !isPlainObject(defaultPayload))
  ) {
    return null;
  }

  return {
    ...(url !== undefined ? { url } : {}),
    ...(format !== undefined ? { format } : {}),
    ...(defaultPayload !== undefined ? { default_payload: defaultPayload } : {}),
  };
}

export function parsePusherRequestBody(value: unknown): PusherRequestBody | null {
  if (!isPlainObject(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const pushkey = record["pushkey"];
  const kind = record["kind"];
  const appId = record["app_id"];
  const appDisplayName = record["app_display_name"];
  const deviceDisplayName = record["device_display_name"];
  const profileTag = record["profile_tag"];
  const lang = record["lang"];
  const data = record["data"];
  const append = record["append"];
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
    ...(kind !== undefined ? { kind: kind } : {}),
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

  const record = value as Record<string, unknown>;
  const actions = parsePushActions(record["actions"]);
  const conditions =
    record["conditions"] === undefined ? undefined : parsePushConditions(record["conditions"]);
  const pattern = record["pattern"];

  if (
    !actions ||
    (record["conditions"] !== undefined && !conditions) ||
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
