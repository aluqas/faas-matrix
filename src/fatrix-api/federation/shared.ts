import type { StoredPduRow } from "../../fatrix-model/types";
import type { AppEnv } from "../hono-env";
import { MatrixApiError } from "../../fatrix-model/utils/errors";
import { DomainError, toMatrixApiError } from "../../fatrix-backend/application/domain-error";
import { runFederationEffect } from "../../fatrix-backend/application/runtime/effect-runtime";
import { withLogContext } from "../../fatrix-backend/application/logging";
export { runDomainValidation } from "../../fatrix-backend/application/domain-validation";
export {
  getFederationEventRowByReference,
  toFederationPduFromRow,
} from "../../platform/cloudflare/adapters/repositories/federation-events-repository";

export type { StoredPduRow };

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
