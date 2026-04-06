import { Effect, Schema } from "effect";
import { ErrorCodes, type RoomId, type UserId } from "../../../../types";
import type {
  DeleteGlobalAccountDataInput,
  DeleteRoomAccountDataInput,
  GetGlobalAccountDataInput,
  GetRoomAccountDataInput,
  PutGlobalAccountDataInput,
  PutRoomAccountDataInput,
} from "../../../../types/account-data";
import type { AccountDataContent, AccountDataEventType } from "../../../../types/account-data";
import { isJsonObject } from "../../../../types/common";
import { RoomIdSchema, UserIdSchema } from "../../../../types/schema";
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

function decodeUserId(rawUserId: string): Effect.Effect<UserId, DomainError> {
  return decodeSchema(UserIdSchema, rawUserId, "Malformed user_id");
}

function decodeRoomId(rawRoomId: string): Effect.Effect<RoomId, DomainError> {
  return decodeSchema(RoomIdSchema, rawRoomId, "Malformed room_id");
}

function decodeAccountDataEventType(
  rawEventType: string,
): Effect.Effect<AccountDataEventType, DomainError> {
  const eventType = rawEventType.trim();
  return eventType
    ? Effect.succeed(eventType)
    : Effect.fail(invalidParam("Account data event type must not be empty"));
}

function decodeAccountDataContent(input: unknown): Effect.Effect<AccountDataContent, DomainError> {
  return isJsonObject(input)
    ? Effect.succeed(input)
    : Effect.fail(malformed("Malformed account data request: expected a JSON object"));
}

export function decodeGetGlobalAccountDataInput(input: {
  authUserId: string;
  targetUserId: string;
  eventType: string;
}): Effect.Effect<GetGlobalAccountDataInput, DomainError> {
  return Effect.gen(function* () {
    return {
      authUserId: yield* decodeUserId(input.authUserId),
      targetUserId: yield* decodeUserId(input.targetUserId),
      eventType: yield* decodeAccountDataEventType(input.eventType),
    };
  });
}

export function decodePutGlobalAccountDataInput(input: {
  authUserId: string;
  targetUserId: string;
  eventType: string;
  body: unknown;
}): Effect.Effect<PutGlobalAccountDataInput, DomainError> {
  return Effect.gen(function* () {
    return {
      authUserId: yield* decodeUserId(input.authUserId),
      targetUserId: yield* decodeUserId(input.targetUserId),
      eventType: yield* decodeAccountDataEventType(input.eventType),
      content: yield* decodeAccountDataContent(input.body),
    };
  });
}

export function decodeDeleteGlobalAccountDataInput(input: {
  authUserId: string;
  targetUserId: string;
  eventType: string;
}): Effect.Effect<DeleteGlobalAccountDataInput, DomainError> {
  return decodeGetGlobalAccountDataInput(input);
}

export function decodeGetRoomAccountDataInput(input: {
  authUserId: string;
  targetUserId: string;
  roomId: string;
  eventType: string;
}): Effect.Effect<GetRoomAccountDataInput, DomainError> {
  return Effect.gen(function* () {
    return {
      authUserId: yield* decodeUserId(input.authUserId),
      targetUserId: yield* decodeUserId(input.targetUserId),
      roomId: yield* decodeRoomId(input.roomId),
      eventType: yield* decodeAccountDataEventType(input.eventType),
    };
  });
}

export function decodePutRoomAccountDataInput(input: {
  authUserId: string;
  targetUserId: string;
  roomId: string;
  eventType: string;
  body: unknown;
}): Effect.Effect<PutRoomAccountDataInput, DomainError> {
  return Effect.gen(function* () {
    return {
      authUserId: yield* decodeUserId(input.authUserId),
      targetUserId: yield* decodeUserId(input.targetUserId),
      roomId: yield* decodeRoomId(input.roomId),
      eventType: yield* decodeAccountDataEventType(input.eventType),
      content: yield* decodeAccountDataContent(input.body),
    };
  });
}

export function decodeDeleteRoomAccountDataInput(input: {
  authUserId: string;
  targetUserId: string;
  roomId: string;
  eventType: string;
}): Effect.Effect<DeleteRoomAccountDataInput, DomainError> {
  return decodeGetRoomAccountDataInput(input);
}
