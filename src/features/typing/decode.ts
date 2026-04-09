import { Effect } from "effect";
import { Errors, type MatrixApiError } from "../../shared/utils/errors";
import { parseRoomIdLike, parseUserIdLike } from "../../shared/utils/ids";

const DEFAULT_TYPING_TIMEOUT = 30000;
const MAX_TYPING_TIMEOUT = 120000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function decodeSetTypingInput(input: {
  authUserId: string;
  roomId: string;
  targetUserId: string;
  body: unknown;
}): Effect.Effect<
  {
    roomId: string;
    userId: string;
    typing: boolean;
    timeoutMs: number;
  },
  MatrixApiError
> {
  return Effect.gen(function* () {
    const authUserId = parseUserIdLike(input.authUserId);
    if (!authUserId) {
      return yield* Effect.fail(Errors.unknownToken());
    }

    const targetUserId = parseUserIdLike(input.targetUserId);
    if (!targetUserId) {
      return yield* Effect.fail(Errors.invalidParam("userId", "Invalid user ID"));
    }

    if (authUserId !== targetUserId) {
      return yield* Effect.fail(Errors.forbidden("Cannot set typing status for other users"));
    }

    const roomId = parseRoomIdLike(input.roomId);
    if (!roomId) {
      return yield* Effect.fail(Errors.invalidParam("roomId", "Invalid room ID"));
    }

    if (!isRecord(input.body)) {
      return yield* Effect.fail(Errors.badJson());
    }

    if (typeof input.body.typing !== "boolean") {
      return yield* Effect.fail(Errors.missingParam("typing"));
    }

    const rawTimeout = input.body.timeout;
    const timeoutMs =
      input.body.typing && typeof rawTimeout === "number"
        ? Math.min(rawTimeout, MAX_TYPING_TIMEOUT)
        : DEFAULT_TYPING_TIMEOUT;

    return {
      roomId,
      userId: authUserId,
      typing: input.body.typing,
      timeoutMs,
    };
  });
}
