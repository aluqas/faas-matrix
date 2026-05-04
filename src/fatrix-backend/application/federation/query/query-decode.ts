import { Effect, Schema } from "effect";
import { ErrorCodes, type EventRelationshipsRequest } from "../../../../fatrix-model/types";
import { isJsonObject } from "../../../../fatrix-model/types/common";
import { EventIdSchema, RoomIdSchema, UserIdSchema } from "../../../../fatrix-model/types/schema";
import { DomainError } from "../../domain-error";
import type {
  FederationDirectoryQueryInput,
  FederationProfileQueryInput,
  FederationServerKeysBatchQueryInput,
  FederationServerKeysQueryInput,
} from "./query-shared";

function malformed(message: string): DomainError {
  return new DomainError({
    kind: "decode_violation",
    errcode: ErrorCodes.M_BAD_JSON,
    message,
    status: 400,
  });
}

function invalidParam(message: string): DomainError {
  return new DomainError({
    kind: "decode_violation",
    errcode: ErrorCodes.M_INVALID_PARAM,
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

function decodeSchema<A>(
  schema: Schema.Schema<A>,
  input: unknown,
  message: string,
): Effect.Effect<A, DomainError> {
  return Schema.decodeUnknown(schema)(input).pipe(
    Effect.mapError((error) => malformed(`${message}: ${error.message}`)),
  );
}

function decodeMinimumValidUntilTs(raw: string | undefined): number {
  if (raw === undefined) {
    return 0;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function decodeServerKeysRequestMap(
  value: unknown,
): Effect.Effect<FederationServerKeysBatchQueryInput["serverKeys"], DomainError> {
  if (!isJsonObject(value)) {
    return Effect.fail(malformed("Malformed server_keys request"));
  }

  const decoded: FederationServerKeysBatchQueryInput["serverKeys"] = {};
  for (const [serverName, keyRequests] of Object.entries(value)) {
    if (!isJsonObject(keyRequests)) {
      return Effect.fail(malformed(`Malformed server key request for ${serverName}`));
    }

    const decodedKeyRequests: Record<string, { minimum_valid_until_ts?: number } | undefined> = {};
    for (const [keyId, keyRequest] of Object.entries(keyRequests)) {
      if (keyRequest === undefined) {
        decodedKeyRequests[keyId] = undefined;
        continue;
      }
      if (!isJsonObject(keyRequest)) {
        return Effect.fail(malformed(`Malformed key request for ${serverName}/${keyId}`));
      }

      const rawMinimumValidUntilTs = keyRequest["minimum_valid_until_ts"];
      if (
        rawMinimumValidUntilTs !== undefined &&
        (typeof rawMinimumValidUntilTs !== "number" || !Number.isFinite(rawMinimumValidUntilTs))
      ) {
        return Effect.fail(invalidParam("minimum_valid_until_ts must be a number"));
      }

      decodedKeyRequests[keyId] =
        rawMinimumValidUntilTs === undefined
          ? {}
          : { minimum_valid_until_ts: rawMinimumValidUntilTs };
    }

    decoded[serverName] = decodedKeyRequests;
  }

  return Effect.succeed(decoded);
}

export function decodeFederationServerKeysBatchQueryInput(
  value: unknown,
): Effect.Effect<FederationServerKeysBatchQueryInput, DomainError> {
  if (!isJsonObject(value)) {
    return Effect.fail(malformed("Malformed federation server keys batch query request"));
  }

  const serverKeys = value["server_keys"];
  if (serverKeys === undefined) {
    return Effect.fail(missingParam("server_keys"));
  }

  return Effect.map(decodeServerKeysRequestMap(serverKeys), (decodedServerKeys) => ({
    serverKeys: decodedServerKeys,
  }));
}

export function decodeFederationServerKeysQueryInput(input: {
  serverName: string;
  keyId?: string;
  minimumValidUntilTs?: string;
}): Effect.Effect<FederationServerKeysQueryInput, DomainError> {
  const serverName = input.serverName.trim();
  if (!serverName) {
    return Effect.fail(invalidParam("server_name must not be empty"));
  }

  return Effect.succeed({
    serverName,
    ...(input.keyId ? { keyId: input.keyId } : {}),
    minimumValidUntilTs: decodeMinimumValidUntilTs(input.minimumValidUntilTs),
  });
}

export function decodeFederationDirectoryQueryInput(input: {
  roomAlias: string | undefined;
}): Effect.Effect<FederationDirectoryQueryInput, DomainError> {
  const roomAlias = input.roomAlias?.trim();
  if (!roomAlias) {
    return Effect.fail(missingParam("room_alias"));
  }

  return Effect.succeed({ roomAlias });
}

export function decodeFederationProfileQueryInput(input: {
  userId: string | undefined;
  field?: string;
}): Effect.Effect<FederationProfileQueryInput, DomainError> {
  if (!input.userId) {
    return Effect.fail(missingParam("user_id"));
  }

  return Effect.gen(function* () {
    const userId = yield* Schema.decodeUnknown(UserIdSchema)(input.userId).pipe(
      Effect.mapError(() => invalidParam("Invalid user_id")),
    );
    if (input.field === undefined) {
      return { userId };
    }
    if (input.field !== "displayname" && input.field !== "avatar_url") {
      return yield* Effect.fail(invalidParam("Invalid profile field"));
    }

    return {
      userId,
      field: input.field,
    };
  });
}

export function decodeFederationEventRelationshipsInput(
  value: unknown,
): Effect.Effect<EventRelationshipsRequest, DomainError> {
  if (!isJsonObject(value)) {
    return Effect.fail(malformed("Malformed event_relationships request"));
  }

  return Effect.gen(function* () {
    const eventId = yield* decodeSchema(EventIdSchema, value["event_id"], "Malformed event_id");
    const roomId =
      value["room_id"] === undefined
        ? undefined
        : yield* decodeSchema(RoomIdSchema, value["room_id"], "Malformed room_id");

    const direction = value["direction"];
    if (direction !== undefined && direction !== "up" && direction !== "down") {
      return yield* Effect.fail(invalidParam("direction must be 'up' or 'down'"));
    }

    const includeParent = value["include_parent"];
    if (includeParent !== undefined && typeof includeParent !== "boolean") {
      return yield* Effect.fail(invalidParam("include_parent must be a boolean"));
    }

    const recentFirst = value["recent_first"];
    if (recentFirst !== undefined && typeof recentFirst !== "boolean") {
      return yield* Effect.fail(invalidParam("recent_first must be a boolean"));
    }

    const maxDepth = value["max_depth"];
    if (maxDepth !== undefined && (typeof maxDepth !== "number" || !Number.isFinite(maxDepth))) {
      return yield* Effect.fail(invalidParam("max_depth must be a number"));
    }

    return {
      eventId,
      ...(roomId ? { roomId } : {}),
      direction: direction === "up" ? "up" : "down",
      ...(includeParent !== undefined ? { includeParent } : {}),
      ...(recentFirst !== undefined ? { recentFirst } : {}),
      ...(maxDepth !== undefined ? { maxDepth } : {}),
    };
  });
}
