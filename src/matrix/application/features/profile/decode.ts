import { Effect, Schema } from "effect";
import { ErrorCodes, type UserId } from "../../../../types";
import { UserIdSchema } from "../../../../types/schema";
import type {
  DeleteCustomProfileKeyInput,
  GetCustomProfileKeyInput,
  PutCustomProfileKeyInput,
  SetAvatarUrlRequest,
  SetDisplayNameRequest,
  UpdateProfileFieldInput,
} from "../../../../types/profile";
import { SetAvatarUrlRequestSchema, SetDisplayNameRequestSchema } from "../../../../types/profile";
import { isJsonObject, isJsonValue } from "../../../../types/common";
import { DomainError } from "../../domain-error";

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

function decodeSchema<A>(
  schema: Schema.Schema<A>,
  input: unknown,
  message: string,
): Effect.Effect<A, DomainError> {
  return Schema.decodeUnknown(schema)(input).pipe(
    Effect.mapError((error) => malformed(`${message}: ${error.message}`)),
  );
}

export function decodeProfileUserId(rawUserId: string): Effect.Effect<UserId, DomainError> {
  return decodeSchema(UserIdSchema, rawUserId, "Malformed user_id");
}

export function decodeSetDisplayNameRequest(
  input: unknown,
): Effect.Effect<SetDisplayNameRequest, DomainError> {
  return decodeSchema(SetDisplayNameRequestSchema, input, "Malformed profile displayname request");
}

export function decodeSetAvatarUrlRequest(
  input: unknown,
): Effect.Effect<SetAvatarUrlRequest, DomainError> {
  return decodeSchema(SetAvatarUrlRequestSchema, input, "Malformed profile avatar_url request");
}

export function decodeProfileFieldUpdateInput(input: {
  authUserId: string;
  targetUserId: string;
  field: "displayname" | "avatar_url";
  body: unknown;
}): Effect.Effect<UpdateProfileFieldInput, DomainError> {
  return Effect.gen(function* () {
    const authUserId = yield* decodeProfileUserId(input.authUserId);
    const targetUserId = yield* decodeProfileUserId(input.targetUserId);
    const request =
      input.field === "displayname"
        ? yield* decodeSetDisplayNameRequest(input.body)
        : yield* decodeSetAvatarUrlRequest(input.body);

    return {
      authUserId,
      targetUserId,
      field: input.field,
      value: input.field === "displayname" ? request.displayname : request.avatar_url,
    };
  });
}

export function decodeGetCustomProfileKeyInput(input: {
  targetUserId: string;
  keyName: string;
}): Effect.Effect<GetCustomProfileKeyInput, DomainError> {
  return Effect.gen(function* () {
    const targetUserId = yield* decodeProfileUserId(input.targetUserId);
    const keyName = input.keyName.trim();
    if (!keyName) {
      yield* Effect.fail(invalidParam("Profile key name must not be empty"));
    }

    return { targetUserId, keyName };
  });
}

export function decodePutCustomProfileKeyInput(input: {
  authUserId: string;
  targetUserId: string;
  keyName: string;
  body: unknown;
}): Effect.Effect<PutCustomProfileKeyInput, DomainError> {
  return Effect.gen(function* () {
    const authUserId = yield* decodeProfileUserId(input.authUserId);
    const targetUserId = yield* decodeProfileUserId(input.targetUserId);
    const keyName = input.keyName.trim();
    if (!keyName) {
      yield* Effect.fail(invalidParam("Profile key name must not be empty"));
    }
    if (!isJsonObject(input.body)) {
      yield* Effect.fail(malformed("Malformed profile key request: expected a JSON object"));
    }

    const value = input.body[keyName];
    if (value === undefined) {
      yield* Effect.fail(
        new DomainError({
          kind: "decode_violation",
          errcode: ErrorCodes.M_MISSING_PARAM,
          message: `Missing '${keyName}' in request body`,
          status: 400,
        }),
      );
    }
    if (!isJsonValue(value)) {
      yield* Effect.fail(invalidParam(`Profile key '${keyName}' must be valid JSON`));
    }

    return { authUserId, targetUserId, keyName, value };
  });
}

export function decodeDeleteCustomProfileKeyInput(input: {
  authUserId: string;
  targetUserId: string;
  keyName: string;
}): Effect.Effect<DeleteCustomProfileKeyInput, DomainError> {
  return Effect.gen(function* () {
    const authUserId = yield* decodeProfileUserId(input.authUserId);
    const targetUserId = yield* decodeProfileUserId(input.targetUserId);
    const keyName = input.keyName.trim();
    if (!keyName) {
      yield* Effect.fail(invalidParam("Profile key name must not be empty"));
    }

    return { authUserId, targetUserId, keyName };
  });
}
