import type { ErrorCode, MatrixError } from "./matrix";

export type DomainErrorKind =
  | "decode_violation"
  | "spec_violation"
  | "auth_violation"
  | "permission_violation"
  | "state_invariant"
  | "unsupported_room_version"
  | "incompatible_room_version";

export interface MatrixApiErrorShape {
  errcode: ErrorCode;
  message: string;
  status: number;
  retryAfterMs?: number;
}

export interface DomainErrorShape {
  kind: DomainErrorKind;
  errcode: ErrorCode;
  message: string;
  status: number;
}

export interface InfraErrorShape {
  errcode: ErrorCode;
  message: string;
  status: number;
  cause?: unknown;
}

export type MatrixErrorResponse = MatrixError;
