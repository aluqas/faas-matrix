import { Effect } from "effect";

type DebugFields = Record<string, unknown>;
type TraceOptions<A> = {
  onSuccess?: (value: A) => DebugFields;
  onError?: (error: Error) => DebugFields;
};

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

export async function emitEffectWarning(label: string, fields: DebugFields = {}): Promise<void> {
  await Effect.runPromise(
    Effect.sync(() => {
      console.warn(label, toSerializableFields(fields));
    }),
  );
}

export async function traceEffectPromise<A>(
  label: string,
  fields: DebugFields,
  operation: () => Promise<A>,
  options: TraceOptions<A> = {},
): Promise<A> {
  return await Effect.runPromise(
    Effect.tryPromise({
      try: operation,
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    }).pipe(
      Effect.tap((value) =>
        Effect.sync(() => {
          console.warn(
            `${label}:ok`,
            toSerializableFields({ ...fields, ...options.onSuccess?.(value) }),
          );
        }),
      ),
      Effect.tapError((error) =>
        Effect.sync(() => {
          console.warn(
            `${label}:error`,
            toSerializableFields({
              ...fields,
              ...options.onError?.(error),
              error,
            }),
          );
        }),
      ),
    ),
  );
}
