import { Data } from "effect";
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

export class InfraError extends Data.TaggedError("InfraError")<{
  readonly errcode: ErrorCode;
  readonly message: string;
  readonly status: number;
  readonly cause?: unknown;
}> {}

export function toMatrixApiError(error: DomainError): MatrixApiError {
  return new MatrixApiError(error.errcode, error.message, error.status);
}
