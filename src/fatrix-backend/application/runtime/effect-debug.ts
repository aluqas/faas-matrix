import { Effect } from "effect";
import { runFederationEffect } from "./effect-runtime";
import { withLogContext } from "../logging";

type DebugFields = Record<string, unknown>;
type TraceOptions<A> = {
  onSuccess?: (value: A) => DebugFields;
  onError?: (error: Error) => DebugFields;
};

const logger = withLogContext({
  component: "effect-debug",
  operation: "compat",
  debugEnabled: true,
});

function toSerializableFields(fields: DebugFields): DebugFields {
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      key,
      value instanceof Error
        ? {
            name: value.name,
            message: value.message,
          }
        : value,
    ]),
  );
}

export function truncateDebugText(value: string, maxLength: number = 1200): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}...<truncated>`;
}

export function emitEffectWarningEffect(
  label: string,
  fields: DebugFields = {},
): Effect.Effect<void> {
  return logger.warn("compat.effect_debug.warning", {
    label,
    ...toSerializableFields(fields),
  });
}

export async function emitEffectWarning(label: string, fields: DebugFields = {}): Promise<void> {
  await runFederationEffect(emitEffectWarningEffect(label, fields));
}

export function traceEffectPromiseEffect<A>(
  label: string,
  fields: DebugFields,
  operation: () => Promise<A>,
  options: TraceOptions<A> = {},
): Effect.Effect<A, Error> {
  return Effect.tryPromise({
    try: operation,
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  }).pipe(
    Effect.tap((value) =>
      logger.warn("compat.effect_debug.trace_ok", {
        label,
        ...toSerializableFields({ ...fields, ...options.onSuccess?.(value) }),
      }),
    ),
    Effect.tapError((error) =>
      logger.error(
        "compat.effect_debug.trace_error",
        error,
        toSerializableFields({
          label,
          ...fields,
          ...options.onError?.(error),
        }),
      ),
    ),
  );
}

export function traceEffectPromise<A>(
  label: string,
  fields: DebugFields,
  operation: () => Promise<A>,
  options: TraceOptions<A> = {},
): Promise<A> {
  return runFederationEffect(traceEffectPromiseEffect(label, fields, operation, options));
}
