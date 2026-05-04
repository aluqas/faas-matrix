import { parseRoomId, parseUserId } from "../fatrix-model/utils/ids";
import type { JsonObject } from "../fatrix-model/types/common";
import { Errors, type MatrixApiError } from "../fatrix-model/utils/errors";

const ROOM_FILTER_KEYS = new Set([
  "rooms",
  "not_rooms",
  "timeline",
  "state",
  "ephemeral",
  "account_data",
  "include_leave",
]);

const EVENT_FILTER_KEYS = new Set([
  "senders",
  "not_senders",
  "types",
  "not_types",
  "limit",
  "lazy_load_members",
  "unread_thread_notifications",
]);

const TOP_LEVEL_FILTER_KEYS = new Set([
  "room",
  "presence",
  "account_data",
  "event_format",
  "event_fields",
]);

function asRecord(value: unknown, path: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw Errors.invalidParam(path, `${path} must be an object`);
  }

  return value as JsonObject;
}

function assertKnownKeys(record: JsonObject, allowedKeys: Set<string>, path: string): void {
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      throw Errors.invalidParam(path, `Unsupported filter field: ${path}.${key}`);
    }
  }
}

function assertStringArray(
  value: unknown,
  path: string,
  validator?: (entry: string) => boolean,
  validatorMessage?: string,
): void {
  if (!Array.isArray(value)) {
    throw Errors.invalidParam(path, `${path} must be an array of strings`);
  }

  for (const entry of value) {
    if (typeof entry !== "string") {
      throw Errors.invalidParam(path, `${path} must be an array of strings`);
    }
    if (validator && !validator(entry)) {
      throw Errors.invalidParam(path, validatorMessage ?? `Invalid value in ${path}`);
    }
  }
}

function assertEventFilter(value: unknown, path: string, allowRoomFlags = false): void {
  const record = asRecord(value, path);
  const allowedKeys = new Set(EVENT_FILTER_KEYS);
  if (!allowRoomFlags) {
    allowedKeys.delete("lazy_load_members");
    allowedKeys.delete("unread_thread_notifications");
  }
  assertKnownKeys(record, allowedKeys, path);

  if ("senders" in record) {
    assertStringArray(
      record["senders"],
      `${path}.senders`,
      (entry) => parseUserId(entry as `@${string}:${string}`) !== null,
      `${path}.senders must contain valid Matrix user IDs`,
    );
  }
  if ("not_senders" in record) {
    assertStringArray(
      record["not_senders"],
      `${path}.not_senders`,
      (entry) => parseUserId(entry as `@${string}:${string}`) !== null,
      `${path}.not_senders must contain valid Matrix user IDs`,
    );
  }
  if ("types" in record) {
    assertStringArray(record["types"], `${path}.types`);
  }
  if ("not_types" in record) {
    assertStringArray(record["not_types"], `${path}.not_types`);
  }
  if (
    "limit" in record &&
    (typeof record["limit"] !== "number" ||
      !Number.isInteger(record["limit"]) ||
      record["limit"] < 0)
  ) {
    throw Errors.invalidParam(`${path}.limit`, `${path}.limit must be a non-negative integer`);
  }
  if ("lazy_load_members" in record && typeof record["lazy_load_members"] !== "boolean") {
    throw Errors.invalidParam(
      `${path}.lazy_load_members`,
      `${path}.lazy_load_members must be a boolean`,
    );
  }
  if (
    "unread_thread_notifications" in record &&
    typeof record["unread_thread_notifications"] !== "boolean"
  ) {
    throw Errors.invalidParam(
      `${path}.unread_thread_notifications`,
      `${path}.unread_thread_notifications must be a boolean`,
    );
  }
}

function assertRoomFilter(value: unknown, path: string): void {
  const record = asRecord(value, path);
  assertKnownKeys(record, ROOM_FILTER_KEYS, path);

  if ("rooms" in record) {
    assertStringArray(
      record["rooms"],
      `${path}.rooms`,
      (entry) => parseRoomId(entry as `!${string}:${string}`) !== null,
      `${path}.rooms must contain valid Matrix room IDs`,
    );
  }
  if ("not_rooms" in record) {
    assertStringArray(
      record["not_rooms"],
      `${path}.not_rooms`,
      (entry) => parseRoomId(entry as `!${string}:${string}`) !== null,
      `${path}.not_rooms must contain valid Matrix room IDs`,
    );
  }
  if ("timeline" in record) {
    assertEventFilter(record["timeline"], `${path}.timeline`, true);
  }
  if ("state" in record) {
    assertEventFilter(record["state"], `${path}.state`, true);
  }
  if ("ephemeral" in record) {
    assertEventFilter(record["ephemeral"], `${path}.ephemeral`);
  }
  if ("account_data" in record) {
    assertEventFilter(record["account_data"], `${path}.account_data`);
  }
  if ("include_leave" in record && typeof record["include_leave"] !== "boolean") {
    throw Errors.invalidParam(`${path}.include_leave`, `${path}.include_leave must be a boolean`);
  }
}

export function validateFilterDefinition(filter: unknown): JsonObject {
  const record = asRecord(filter, "filter");
  assertKnownKeys(record, TOP_LEVEL_FILTER_KEYS, "filter");

  if ("room" in record) {
    assertRoomFilter(record["room"], "filter.room");
  }
  if ("presence" in record) {
    assertEventFilter(record["presence"], "filter.presence");
  }
  if ("account_data" in record) {
    assertEventFilter(record["account_data"], "filter.account_data");
  }
  if (
    "event_format" in record &&
    record["event_format"] !== "client" &&
    record["event_format"] !== "federation"
  ) {
    throw Errors.invalidParam(
      "filter.event_format",
      "filter.event_format must be 'client' or 'federation'",
    );
  }
  if ("event_fields" in record) {
    assertStringArray(record["event_fields"], "filter.event_fields");
  }

  return record;
}

export function toFilterValidationError(error: unknown): MatrixApiError {
  if (error instanceof Error && "toResponse" in error) {
    return error as MatrixApiError;
  }

  return Errors.badJson();
}
