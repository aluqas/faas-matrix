import { Effect } from "effect";
import type {
  DeleteGlobalAccountDataInput,
  DeleteRoomAccountDataInput,
  NotifyAccountDataChangeInput,
  PutGlobalAccountDataInput,
  PutRoomAccountDataInput,
} from "../../../../types/account-data";
import type { RoomId, UserId } from "../../../../types/matrix";
import { Errors, MatrixApiError } from "../../../../utils/errors";
import { InfraError } from "../../domain-error";

export interface AccountDataCommandPorts {
  putGlobalAccountData(
    userId: UserId,
    eventType: string,
    content: PutGlobalAccountDataInput["content"],
  ): Effect.Effect<void, InfraError>;
  deleteGlobalAccountData(userId: UserId, eventType: string): Effect.Effect<void, InfraError>;
  putRoomAccountData(
    userId: UserId,
    roomId: RoomId,
    eventType: string,
    content: PutRoomAccountDataInput["content"],
  ): Effect.Effect<void, InfraError>;
  deleteRoomAccountData(
    userId: UserId,
    roomId: RoomId,
    eventType: string,
  ): Effect.Effect<void, InfraError>;
  isUserJoinedToRoom(userId: UserId, roomId: RoomId): Effect.Effect<boolean, InfraError>;
  notifyAccountDataChange(input: NotifyAccountDataChangeInput): Effect.Effect<void, InfraError>;
}

function ensureOwnAccountData(
  authUserId: UserId,
  targetUserId: UserId,
): Effect.Effect<void, MatrixApiError> {
  return authUserId === targetUserId
    ? Effect.void
    : Effect.fail(Errors.forbidden("Cannot modify other users account data"));
}

function ensureJoinedRoom(
  ports: AccountDataCommandPorts,
  userId: UserId,
  roomId: RoomId,
): Effect.Effect<void, MatrixApiError | InfraError> {
  return Effect.flatMap(ports.isUserJoinedToRoom(userId, roomId), (joined) =>
    joined ? Effect.void : Effect.fail(Errors.forbidden("User not in room")),
  );
}

export function putGlobalAccountDataEffect(
  ports: AccountDataCommandPorts,
  input: PutGlobalAccountDataInput,
): Effect.Effect<void, MatrixApiError | InfraError> {
  return Effect.gen(function* () {
    yield* ensureOwnAccountData(input.authUserId, input.targetUserId);
    yield* ports.putGlobalAccountData(input.targetUserId, input.eventType, input.content);
    yield* ports.notifyAccountDataChange({
      userId: input.targetUserId,
      eventType: input.eventType,
    });
  });
}

export function deleteGlobalAccountDataEffect(
  ports: AccountDataCommandPorts,
  input: DeleteGlobalAccountDataInput,
): Effect.Effect<void, MatrixApiError | InfraError> {
  return Effect.gen(function* () {
    yield* ensureOwnAccountData(input.authUserId, input.targetUserId);
    yield* ports.deleteGlobalAccountData(input.targetUserId, input.eventType);
    yield* ports.notifyAccountDataChange({
      userId: input.targetUserId,
      eventType: input.eventType,
    });
  });
}

export function putRoomAccountDataEffect(
  ports: AccountDataCommandPorts,
  input: PutRoomAccountDataInput,
): Effect.Effect<void, MatrixApiError | InfraError> {
  return Effect.gen(function* () {
    yield* ensureOwnAccountData(input.authUserId, input.targetUserId);
    yield* ensureJoinedRoom(ports, input.targetUserId, input.roomId);
    yield* ports.putRoomAccountData(
      input.targetUserId,
      input.roomId,
      input.eventType,
      input.content,
    );
    yield* ports.notifyAccountDataChange({
      userId: input.targetUserId,
      roomId: input.roomId,
      eventType: input.eventType,
    });
  });
}

export function deleteRoomAccountDataEffect(
  ports: AccountDataCommandPorts,
  input: DeleteRoomAccountDataInput,
): Effect.Effect<void, MatrixApiError | InfraError> {
  return Effect.gen(function* () {
    yield* ensureOwnAccountData(input.authUserId, input.targetUserId);
    yield* ensureJoinedRoom(ports, input.targetUserId, input.roomId);
    yield* ports.deleteRoomAccountData(input.targetUserId, input.roomId, input.eventType);
    yield* ports.notifyAccountDataChange({
      userId: input.targetUserId,
      roomId: input.roomId,
      eventType: input.eventType,
    });
  });
}
