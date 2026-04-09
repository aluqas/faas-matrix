import { Effect } from "effect";
import type { RoomId, UserId } from "../types/matrix";
import { Errors, MatrixApiError } from "../utils/errors";
import { isLocalServerName, parseUserId } from "../utils/ids";
import type { InfraError } from "../../matrix/application/domain-error";

export function requireOwnUser(
  authUserId: UserId,
  targetUserId: UserId,
  errorMessage: string,
): Effect.Effect<void, MatrixApiError> {
  return authUserId === targetUserId
    ? Effect.void
    : Effect.fail(Errors.forbidden(errorMessage));
}

export function requireLocalUser(
  userId: UserId,
  localServerName: string,
): Effect.Effect<void, MatrixApiError> {
  const parsed = parseUserId(userId);
  return parsed && isLocalServerName(parsed.serverName, localServerName)
    ? Effect.void
    : Effect.fail(Errors.notFound("User not found"));
}

export function requireJoinedRoom(
  checkMembership: (userId: UserId, roomId: RoomId) => Effect.Effect<boolean, InfraError>,
  userId: UserId,
  roomId: RoomId,
): Effect.Effect<void, MatrixApiError | InfraError> {
  return checkMembership(userId, roomId).pipe(
    Effect.flatMap((joined) =>
      joined ? Effect.void : Effect.fail(Errors.forbidden("User not in room")),
    ),
  );
}
