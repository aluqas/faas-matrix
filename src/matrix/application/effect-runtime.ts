import { Effect } from "effect";
import { MatrixApiError } from "../../utils/errors";
import { DomainError, InfraError, toMatrixApiError } from "./domain-error";

type RuntimeKind = "client" | "federation" | "workflow" | "durable_object";

function toFallbackMatrixApiError(kind: RuntimeKind, error: unknown): MatrixApiError {
  if (error instanceof MatrixApiError) {
    return error;
  }

  const message =
    error instanceof Error
      ? error.message
      : `${kind} effect failed with a non-error rejection: ${String(error)}`;
  return new MatrixApiError("M_UNKNOWN", message, 500);
}

async function runEffect<A, E>(effect: Effect.Effect<A, E>, kind: RuntimeKind): Promise<A> {
  try {
    return await Effect.runPromise(effect);
  } catch (error) {
    if (error instanceof DomainError) {
      throw toMatrixApiError(error);
    }

    if (error instanceof InfraError) {
      throw new MatrixApiError(error.errcode, error.message, error.status);
    }

    throw toFallbackMatrixApiError(kind, error);
  }
}

export function runClientEffect<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  return runEffect(effect, "client");
}

export function runFederationEffect<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  return runEffect(effect, "federation");
}

export function runWorkflowEffect<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  return runEffect(effect, "workflow");
}

export function runDurableObjectEffect<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  return runEffect(effect, "durable_object");
}
