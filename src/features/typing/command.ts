import { Effect } from "effect";
import type { TypingCommandInput, TypingCommandPorts } from "./contracts";
import { runClientEffect } from "../../matrix/application/runtime/effect-runtime";
import { withLogContext } from "../../matrix/application/logging";
import { Errors, type MatrixApiError } from "../../shared/utils/errors";
import { InfraError } from "../../matrix/application/domain-error";

export interface TypingRequestPorts {
  membership: {
    isUserJoinedToRoom(
      roomId: string,
      userId: string,
    ): Effect.Effect<boolean, InfraError>;
  };
  executor: {
    execute(input: TypingCommandInput): Effect.Effect<void, InfraError>;
  };
}

export async function executeTypingCommand(
  input: TypingCommandInput,
  ports: TypingCommandPorts,
): Promise<void> {
  const logger = withLogContext({
    component: "typing",
    operation: "command",
    room_id: input.roomId,
    user_id: input.userId,
    debugEnabled: ports.debugEnabled,
  });

  await runClientEffect(
    logger.info("typing.command.start", {
      typing: input.typing,
      timeout_ms: input.timeoutMs,
    }),
  );

  await ports.setRoomTyping(input.roomId, input.userId, input.typing, input.timeoutMs);

  const destinations = [...new Set(await ports.resolveInterestedServers(input.roomId))];
  await runClientEffect(
    logger.debug("typing.command.resolve_destinations", {
      destination_count: destinations.length,
      destinations,
    }),
  );
  if (destinations.length === 0) {
    await runClientEffect(logger.info("typing.command.success", { destination_count: 0 }));
    return;
  }

  const content = {
    room_id: input.roomId,
    user_id: input.userId,
    typing: input.typing,
    timeout: input.timeoutMs,
  };

  await Promise.all(destinations.map((destination) => ports.queueEdu(destination, content)));
  await runClientEffect(
    logger.info("typing.command.success", {
      destination_count: destinations.length,
    }),
  );
}

export function setTypingEffect(
  ports: TypingRequestPorts,
  input: TypingCommandInput,
): Effect.Effect<void, MatrixApiError | InfraError> {
  return Effect.gen(function* () {
    const joined = yield* ports.membership.isUserJoinedToRoom(input.roomId, input.userId);
    if (!joined) {
      return yield* Effect.fail(Errors.forbidden("Not a member of this room"));
    }

    yield* ports.executor.execute(input);
  });
}
