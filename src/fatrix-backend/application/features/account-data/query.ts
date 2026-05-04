import { Effect } from "effect";
import type {
  AccountDataContent,
  GetGlobalAccountDataInput,
  GetRoomAccountDataInput,
} from "../../../../fatrix-model/types/account-data";
import type { RoomId, UserId } from "../../../../fatrix-model/types/matrix";
import { Errors, MatrixApiError } from "../../../../fatrix-model/utils/errors";
import { InfraError } from "../../domain-error";
import { requireJoinedRoom, requireOwnUser } from "../../effect/guards";

export interface AccountDataReaderService {
  getGlobalAccountData(
    userId: UserId,
    eventType: string,
  ): Effect.Effect<AccountDataContent | null, InfraError>;
  getRoomAccountData(
    userId: UserId,
    roomId: RoomId,
    eventType: string,
  ): Effect.Effect<AccountDataContent | null, InfraError>;
}

export interface AccountDataMembershipService {
  isUserJoinedToRoom(userId: UserId, roomId: RoomId): Effect.Effect<boolean, InfraError>;
}

export interface AccountDataQueryPorts {
  accountDataReader: AccountDataReaderService;
  membership: AccountDataMembershipService;
}

export function queryGlobalAccountDataEffect(
  ports: AccountDataQueryPorts,
  input: GetGlobalAccountDataInput,
): Effect.Effect<AccountDataContent, MatrixApiError | InfraError> {
  return Effect.gen(function* () {
    yield* requireOwnUser(
      input.authUserId,
      input.targetUserId,
      "Cannot access other users account data",
    );
    const content = yield* ports.accountDataReader.getGlobalAccountData(
      input.targetUserId,
      input.eventType,
    );
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
    yield* requireOwnUser(
      input.authUserId,
      input.targetUserId,
      "Cannot access other users account data",
    );
    yield* requireJoinedRoom(
      (userId, roomId) => ports.membership.isUserJoinedToRoom(userId, roomId),
      input.targetUserId,
      input.roomId,
    );
    const content = yield* ports.accountDataReader.getRoomAccountData(
      input.targetUserId,
      input.roomId,
      input.eventType,
    );
    return yield* content
      ? Effect.succeed(content)
      : Effect.fail(Errors.notFound("Account data not found"));
  });
}
