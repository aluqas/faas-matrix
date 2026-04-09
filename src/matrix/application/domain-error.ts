import { Data } from "effect";
import type { DomainErrorKind, DomainErrorShape, InfraErrorShape } from "../../shared/types/error";
import { MatrixApiError } from "../../shared/utils/errors";
export type { DomainErrorKind };

export class DomainError extends Data.TaggedError("DomainError")<DomainErrorShape> {}

export class InfraError extends Data.TaggedError("InfraError")<InfraErrorShape> {}

export function toMatrixApiError(error: DomainError): MatrixApiError {
  return new MatrixApiError(error.errcode, error.message, error.status);
}
