import { Effect } from "effect";
import type {
  AccountDataContent,
  GetGlobalAccountDataInput,
  GetRoomAccountDataInput,
} from "../../../../types/account-data";
import type { RoomId, UserId } from "../../../../types/matrix";
import { Errors, MatrixApiError } from "../../../../utils/errors";
import { InfraError } from "../../domain-error";

export interface AccountDataQueryPorts {
  getGlobalAccountData(
    userId: UserId,
    eventType: string,
  ): Effect.Effect<AccountDataContent | null, InfraError>;
  getRoomAccountData(
    userId: UserId,
    roomId: RoomId,
    eventType: string,
  ): Effect.Effect<AccountDataContent | null, InfraError>;
  isUserJoinedToRoom(userId: UserId, roomId: RoomId): Effect.Effect<boolean, InfraError>;
}

function ensureOwnAccountData(
  authUserId: UserId,
  targetUserId: UserId,
  verb: "access" | "modify",
): Effect.Effect<void, MatrixApiError> {
  return authUserId === targetUserId
    ? Effect.void
    : Effect.fail(Errors.forbidden(`Cannot ${verb} other users account data`));
}

function ensureJoinedRoom(
  ports: AccountDataQueryPorts,
  userId: UserId,
  roomId: RoomId,
): Effect.Effect<void, MatrixApiError | InfraError> {
  return Effect.flatMap(ports.isUserJoinedToRoom(userId, roomId), (joined) =>
    joined ? Effect.void : Effect.fail(Errors.forbidden("User not in room")),
  );
}

export function queryGlobalAccountDataEffect(
  ports: AccountDataQueryPorts,
  input: GetGlobalAccountDataInput,
): Effect.Effect<AccountDataContent, MatrixApiError | InfraError> {
  return Effect.gen(function* () {
    yield* ensureOwnAccountData(input.authUserId, input.targetUserId, "access");
    const content = yield* ports.getGlobalAccountData(input.targetUserId, input.eventType);
    return yield* content
      ? Effect.succeed(content)
      : Effect.fail(Errors.notFound("Account data not found"));
  });
}

export function queryRoomAccountDataEffect(
  ports: AccountDataQueryPorts,
  input: GetRoomAccountDataInput,
): Effect.Effect<AccountDataContent, MatrixApiError | InfraError> {
  return Effect.gen(function* () {
    yield* ensureOwnAccountData(input.authUserId, input.targetUserId, "access");
    yield* ensureJoinedRoom(ports, input.targetUserId, input.roomId);
    const content = yield* ports.getRoomAccountData(
      input.targetUserId,
      input.roomId,
      input.eventType,
    );
    return yield* content
      ? Effect.succeed(content)
      : Effect.fail(Errors.notFound("Account data not found"));
  });
}
