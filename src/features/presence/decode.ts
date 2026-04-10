import { Effect } from "effect";
import type { PresenceState, UserId } from "../../shared/types";
import { Errors, type MatrixApiError } from "../../shared/utils/errors";
import { parseUserIdLike } from "../../shared/utils/ids";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export interface SetPresenceStatusInput {
  userId: UserId;
  presence: PresenceState;
  statusMessage?: string;
  now: number;
}

export interface GetPresenceStatusInput {
  userId: UserId;
}

export function decodeSetPresenceStatusInput(input: {
  authUserId: string;
  targetUserId: string;
  body: unknown;
  now: number;
}): Effect.Effect<SetPresenceStatusInput, MatrixApiError> {
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
      return yield* Effect.fail(Errors.forbidden("Cannot set presence for other users"));
    }

    if (!isRecord(input.body)) {
      return yield* Effect.fail(Errors.badJson());
    }

    const rawPresence = input.body["presence"];
    if (rawPresence !== "online" && rawPresence !== "offline" && rawPresence !== "unavailable") {
      return yield* Effect.fail(
        typeof rawPresence === "string"
          ? Errors.invalidParam(
              "presence",
              `Invalid presence: ${rawPresence}. Must be one of: online, offline, unavailable`,
            )
          : Errors.missingParam("presence"),
      );
    }

    const rawStatusMessage = input.body["status_msg"];
    if (rawStatusMessage !== undefined && typeof rawStatusMessage !== "string") {
      return yield* Effect.fail(Errors.invalidParam("status_msg", "status_msg must be a string"));
    }

    return {
      userId: authUserId,
      presence: rawPresence,
      ...(rawStatusMessage !== undefined ? { statusMessage: rawStatusMessage } : {}),
      now: input.now,
    };
  });
}

export function decodeGetPresenceStatusInput(input: {
  targetUserId: string;
}): Effect.Effect<GetPresenceStatusInput, MatrixApiError> {
  return Effect.gen(function* () {
    const userId = parseUserIdLike(input.targetUserId);
    if (!userId) {
      return yield* Effect.fail(Errors.invalidParam("userId", "Invalid user ID"));
    }

    return { userId };
  });
}
