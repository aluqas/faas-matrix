import { Data, Effect } from "effect";
import type { ErrorCode } from "../../types";
import { MatrixApiError } from "../../utils/errors";

export type DomainErrorKind =
  | "spec_violation"
  | "auth_violation"
  | "state_invariant"
  | "unsupported_room_version"
  | "incompatible_room_version";

export class DomainError extends Data.TaggedError("DomainError")<{
  readonly kind: DomainErrorKind;
  readonly errcode: ErrorCode;
  readonly message: string;
  readonly status: number;
}> {}

export function toMatrixApiError(error: DomainError): MatrixApiError {
  return new MatrixApiError(error.errcode, error.message, error.status);
}

export async function runDomainEffect<A>(effect: Effect.Effect<A, DomainError>): Promise<A> {
  try {
    return await Effect.runPromise(effect);
  } catch (error) {
    if (error instanceof DomainError) {
      throw toMatrixApiError(error);
    }
    throw error;
  }
}
