import { Effect } from "effect";
import type {
  DeleteGlobalAccountDataInput,
  DeleteRoomAccountDataInput,
  NotifyAccountDataChangeInput,
  PutGlobalAccountDataInput,
  PutRoomAccountDataInput,
} from "../../shared/types/account-data";
import { isEmptyAccountDataContent } from "../../shared/types/account-data";
import type { RoomId, UserId } from "../../shared/types/matrix";
import type { MatrixApiError } from "../../shared/utils/errors";
import { InfraError } from "../../matrix/application/domain-error";
import { requireJoinedRoom, requireOwnUser } from "../../shared/effect/guards";

export interface AccountDataMembershipService {
  isUserJoinedToRoom(userId: UserId, roomId: RoomId): Effect.Effect<boolean, InfraError>;
}

export interface AccountDataWriterService {
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
}

export interface AccountDataNotifierService {
  notifyAccountDataChange(input: NotifyAccountDataChangeInput): Effect.Effect<void, InfraError>;
}

export interface AccountDataCommandPorts {
  membership: AccountDataMembershipService;
  accountDataWriter: AccountDataWriterService;
  accountDataNotifier: AccountDataNotifierService;
}

export function putGlobalAccountDataEffect(
  ports: AccountDataCommandPorts,
  input: PutGlobalAccountDataInput,
): Effect.Effect<void, MatrixApiError | InfraError> {
  return Effect.gen(function* () {
    yield* requireOwnUser(input.authUserId, input.targetUserId, "Cannot modify other users account data");
    yield* ports.accountDataWriter.putGlobalAccountData(input.targetUserId, input.eventType, input.content);
    yield* ports.accountDataNotifier.notifyAccountDataChange({
      userId: input.targetUserId,
      eventType: input.eventType,
    });
  });
}

export function upsertGlobalAccountDataEffect(
  ports: AccountDataCommandPorts,
  input: PutGlobalAccountDataInput,
): Effect.Effect<void, MatrixApiError | InfraError> {
  return isEmptyAccountDataContent(input.content)
    ? deleteGlobalAccountDataEffect(ports, input)
    : putGlobalAccountDataEffect(ports, input);
}

export function deleteGlobalAccountDataEffect(
  ports: AccountDataCommandPorts,
  input: DeleteGlobalAccountDataInput,
): Effect.Effect<void, MatrixApiError | InfraError> {
  return Effect.gen(function* () {
    yield* requireOwnUser(input.authUserId, input.targetUserId, "Cannot modify other users account data");
    yield* ports.accountDataWriter.deleteGlobalAccountData(input.targetUserId, input.eventType);
    yield* ports.accountDataNotifier.notifyAccountDataChange({
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
    yield* requireOwnUser(input.authUserId, input.targetUserId, "Cannot modify other users account data");
    yield* requireJoinedRoom(
      (userId, roomId) => ports.membership.isUserJoinedToRoom(userId, roomId),
      input.targetUserId,
      input.roomId,
    );
    yield* ports.accountDataWriter.putRoomAccountData(
      input.targetUserId,
      input.roomId,
      input.eventType,
      input.content,
    );
    yield* ports.accountDataNotifier.notifyAccountDataChange({
      userId: input.targetUserId,
      roomId: input.roomId,
      eventType: input.eventType,
    });
  });
}

export function upsertRoomAccountDataEffect(
  ports: AccountDataCommandPorts,
  input: PutRoomAccountDataInput,
): Effect.Effect<void, MatrixApiError | InfraError> {
  return isEmptyAccountDataContent(input.content)
    ? deleteRoomAccountDataEffect(ports, input)
    : putRoomAccountDataEffect(ports, input);
}

export function deleteRoomAccountDataEffect(
  ports: AccountDataCommandPorts,
  input: DeleteRoomAccountDataInput,
): Effect.Effect<void, MatrixApiError | InfraError> {
  return Effect.gen(function* () {
    yield* requireOwnUser(input.authUserId, input.targetUserId, "Cannot modify other users account data");
    yield* requireJoinedRoom(
      (userId, roomId) => ports.membership.isUserJoinedToRoom(userId, roomId),
      input.targetUserId,
      input.roomId,
    );
    yield* ports.accountDataWriter.deleteRoomAccountData(input.targetUserId, input.roomId, input.eventType);
    yield* ports.accountDataNotifier.notifyAccountDataChange({
      userId: input.targetUserId,
      roomId: input.roomId,
      eventType: input.eventType,
    });
  });
}
