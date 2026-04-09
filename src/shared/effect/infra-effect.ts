import { Effect } from "effect";
import { InfraError } from "../../matrix/application/domain-error";

export function toInfraError(message: string, cause: unknown, status = 500): InfraError {
  return new InfraError({
    errcode: "M_UNKNOWN",
    message,
    status,
    cause,
  });
}

export function fromInfraPromise<A>(
  fn: () => Promise<A>,
  message: string,
): Effect.Effect<A, InfraError> {
  return Effect.tryPromise({ try: fn, catch: (cause) => toInfraError(message, cause) });
}

export function fromInfraNullable<A>(
  fn: () => Promise<A | null>,
  message: string,
): Effect.Effect<A | null, InfraError> {
  return fromInfraPromise(fn, message);
}

export function fromInfraVoid(
  fn: () => Promise<unknown>,
  message: string,
): Effect.Effect<void, InfraError> {
  return fromInfraPromise(fn, message).pipe(Effect.asVoid);
}
