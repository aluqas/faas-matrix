import { Effect } from "effect";
import type { AppEnv, MatrixSignatures, PDU } from "../../types";
import type { FederationEventRow } from "../../types/federation";
import { MatrixApiError } from "../../utils/errors";
import { DomainError, toMatrixApiError } from "../../matrix/application/domain-error";
import { runFederationEffect } from "../../matrix/application/effect-runtime";
import { withLogContext } from "../../matrix/application/logging";

export type { FederationEventRow };

export function runDomainValidation<A>(effect: Effect.Effect<A, DomainError>): Promise<A> {
  return runFederationEffect(effect);
}

export function toFederationErrorResponse(error: unknown): Response | null {
  if (error instanceof DomainError) {
    return toMatrixApiError(error).toResponse();
  }
  if (error instanceof MatrixApiError) {
    return error.toResponse();
  }
  return null;
}

export async function logFederationRouteWarning(
  c: { get: (key: string) => unknown },
  operation: string,
  fields: Record<string, unknown>,
): Promise<void> {
  const logger = withLogContext({
    component: "federation-route",
    operation,
    origin:
      typeof c.get("federationOrigin") === "string"
        ? (c.get("federationOrigin") as string)
        : undefined,
    debugEnabled: true,
  });
  await runFederationEffect(logger.warn(`federation.${operation}.trace`, fields));
}

function getEventReferenceLookupCandidates(eventId: string): string[] {
  const normalized = eventId.replaceAll("+", "-").replaceAll("/", "_");
  const standard = eventId.replaceAll("-", "+").replaceAll("_", "/");
  return Array.from(new Set([eventId, normalized, standard]));
}

export async function getFederationEventRowByReference(
  db: D1Database,
  eventId: string,
): Promise<FederationEventRow | null> {
  for (const candidate of getEventReferenceLookupCandidates(eventId)) {
    const row = await db
      .prepare(
        `SELECT event_id, room_id, sender, event_type, state_key, content,
         origin_server_ts, depth, auth_events, prev_events, event_origin, event_membership,
         prev_state, hashes, signatures
         FROM events WHERE event_id = ?`,
      )
      .bind(candidate)
      .first<FederationEventRow>();
    if (row) {
      return row;
    }
  }
  return null;
}

export function parseJsonWithFallback<T>(value: string | null | undefined, fallback: T): T {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function toFederationPduFromRow(row: FederationEventRow): PDU {
  return {
    event_id: row.event_id,
    room_id: row.room_id,
    sender: row.sender,
    type: row.event_type,
    ...(row.state_key !== null ? { state_key: row.state_key } : {}),
    ...(row.event_origin ? { origin: row.event_origin } : {}),
    ...(row.event_membership
      ? {
          membership: row.event_membership as "join" | "invite" | "leave" | "ban" | "knock",
        }
      : {}),
    ...(row.prev_state ? { prev_state: parseJsonWithFallback<string[]>(row.prev_state, []) } : {}),
    content: parseJsonWithFallback<Record<string, unknown>>(row.content, {}),
    origin_server_ts: row.origin_server_ts,
    depth: row.depth,
    auth_events: parseJsonWithFallback<string[]>(row.auth_events, []),
    prev_events: parseJsonWithFallback<string[]>(row.prev_events, []),
    ...(row.hashes ? { hashes: parseJsonWithFallback(row.hashes, { sha256: "" }) } : {}),
    ...(row.signatures
      ? {
          signatures: parseJsonWithFallback<MatrixSignatures>(row.signatures, {}),
        }
      : {}),
  };
}

function getUserKeysDO(env: AppEnv["Bindings"], userId: string): DurableObjectStub {
  const id = env.USER_KEYS.idFromName(userId);
  return env.USER_KEYS.get(id);
}

export async function getDeviceKeysFromDO(
  env: AppEnv["Bindings"],
  userId: string,
  deviceId?: string,
): Promise<any> {
  const stub = getUserKeysDO(env, userId);
  const url = deviceId
    ? `http://internal/device-keys/get?device_id=${encodeURIComponent(deviceId)}`
    : "http://internal/device-keys/get";
  const response = await stub.fetch(new Request(url));
  if (!response.ok) {
    return deviceId ? null : {};
  }
  return response.json();
}

export async function getCrossSigningKeysFromDO(
  env: AppEnv["Bindings"],
  userId: string,
): Promise<{
  master?: any;
  self_signing?: any;
  user_signing?: any;
}> {
  const stub = getUserKeysDO(env, userId);
  const response = await stub.fetch(new Request("http://internal/cross-signing/get"));
  if (!response.ok) {
    return {};
  }
  return response.json();
}
