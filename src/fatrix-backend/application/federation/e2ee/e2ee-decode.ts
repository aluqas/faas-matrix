import { Effect, Schema } from "effect";
import {
  ErrorCodes,
  type FederationKeysClaimInput,
  type FederationKeysQueryInput,
  type FederationUserDevicesInput,
} from "../../../../fatrix-model/types";
import { isJsonObject } from "../../../../fatrix-model/types/common";
import { UserIdSchema } from "../../../../fatrix-model/types/schema";
import {
  parseE2EEKeysClaimRequest,
  parseE2EEKeysQueryRequest,
} from "../../../../fatrix-model/types/e2ee";
import { DomainError } from "../../domain-error";

function malformed(message: string): DomainError {
  return new DomainError({
    kind: "decode_violation",
    errcode: ErrorCodes.M_BAD_JSON,
    message,
    status: 400,
  });
}

function missingParam(param: string): DomainError {
  return new DomainError({
    kind: "decode_violation",
    errcode: ErrorCodes.M_MISSING_PARAM,
    message: `Missing required parameter: ${param}`,
    status: 400,
  });
}

export function decodeFederationKeysQueryInput(
  value: unknown,
): Effect.Effect<FederationKeysQueryInput, DomainError> {
  if (!isJsonObject(value)) {
    return Effect.fail(malformed("Malformed federation keys query request"));
  }
  if (value["device_keys"] === undefined) {
    return Effect.fail(missingParam("device_keys"));
  }
  const parsed = parseE2EEKeysQueryRequest(value);
  return parsed
    ? Effect.succeed(parsed)
    : Effect.fail(malformed("Malformed federation keys query request"));
}

export function decodeFederationKeysClaimInput(
  value: unknown,
): Effect.Effect<FederationKeysClaimInput, DomainError> {
  if (!isJsonObject(value)) {
    return Effect.fail(malformed("Malformed federation keys claim request"));
  }
  if (value["one_time_keys"] === undefined) {
    return Effect.fail(missingParam("one_time_keys"));
  }
  const parsed = parseE2EEKeysClaimRequest(value);
  return parsed
    ? Effect.succeed(parsed)
    : Effect.fail(malformed("Malformed federation keys claim request"));
}

export function decodeFederationUserDevicesInput(
  rawUserId: string,
): Effect.Effect<FederationUserDevicesInput, DomainError> {
  return Schema.decodeUnknown(UserIdSchema)(rawUserId).pipe(
    Effect.map((userId) => ({ userId })),
    Effect.mapError((error) => malformed(`Malformed user_id: ${error.message}`)),
  );
}
