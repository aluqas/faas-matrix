import { Effect } from "effect";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogEventName = `${string}.${string}.${string}`;

export interface LogContext {
  component: string;
  operation?: string | undefined;
  request_id?: string | undefined;
  txn_id?: string | undefined;
  room_id?: string | undefined;
  event_id?: string | undefined;
  user_id?: string | undefined;
  device_id?: string | undefined;
  origin?: string | undefined;
  destination?: string | undefined;
  room_version?: string | undefined;
  debugEnabled?: boolean | undefined;
}

type LogFields = Record<string, unknown>;
type Logger = {
  debug: (event: LogEventName, fields?: LogFields) => Effect.Effect<void>;
  info: (event: LogEventName, fields?: LogFields) => Effect.Effect<void>;
  warn: (event: LogEventName, fields?: LogFields) => Effect.Effect<void>;
  error: (event: LogEventName, error: unknown, fields?: LogFields) => Effect.Effect<void>;
};

const REDACTED_VALUE = "[redacted]";
const SENSITIVE_KEYS = new Set([
  "access_token",
  "refresh_token",
  "password",
  "private_key",
  "private_key_jwk",
  "device_keys",
  "one_time_keys",
  "fallback_keys",
  "content",
  "messages",
  "keys",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sanitizeValue(value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeValue(entry));
  }

  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        SENSITIVE_KEYS.has(key) ? REDACTED_VALUE : sanitizeValue(entry),
      ]),
    );
  }

  return value;
}

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      error_name: error.name,
      error_message: error.message,
      error_stack: error.stack,
    };
  }

  return {
    error_name: "UnknownError",
    error_message: String(error),
  };
}

function emitLog(
  level: LogLevel,
  event: LogEventName,
  context: LogContext,
  fields: LogFields = {},
) {
  if (level === "debug" && !context.debugEnabled) {
    return;
  }

  const sanitizedFields = sanitizeValue(fields);
  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    component: context.component,
    operation: context.operation,
    request_id: context.request_id,
    txn_id: context.txn_id,
    room_id: context.room_id,
    event_id: context.event_id,
    user_id: context.user_id,
    device_id: context.device_id,
    origin: context.origin,
    destination: context.destination,
    room_version: context.room_version,
    ...(isPlainObject(sanitizedFields) ? sanitizedFields : {}),
  };

  const payload = JSON.stringify(
    Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined)),
  );

  if (level === "error") {
    console.error(payload);
  } else if (level === "warn") {
    console.warn(payload);
  } else {
    console.log(payload);
  }
}

export function logDebug(
  event: LogEventName,
  context: LogContext,
  fields: LogFields = {},
): Effect.Effect<void> {
  return Effect.sync(() => {
    emitLog("debug", event, context, fields);
  });
}

export function logInfo(
  event: LogEventName,
  context: LogContext,
  fields: LogFields = {},
): Effect.Effect<void> {
  return Effect.sync(() => {
    emitLog("info", event, context, fields);
  });
}

export function logWarn(
  event: LogEventName,
  context: LogContext,
  fields: LogFields = {},
): Effect.Effect<void> {
  return Effect.sync(() => {
    emitLog("warn", event, context, fields);
  });
}

export function logError(
  event: LogEventName,
  context: LogContext,
  error: unknown,
  fields: LogFields = {},
): Effect.Effect<void> {
  return Effect.sync(() => {
    emitLog("error", event, context, {
      ...fields,
      ...serializeError(error),
    });
  });
}

export function withLogContext(context: LogContext): Logger {
  return {
    debug: (event, fields = {}) => logDebug(event, context, fields),
    info: (event, fields = {}) => logInfo(event, context, fields),
    warn: (event, fields = {}) => logWarn(event, context, fields),
    error: (event, error, fields = {}) => logError(event, context, error, fields),
  };
}
