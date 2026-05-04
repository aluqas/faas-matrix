import { Effect } from "effect";
import type { TypingCommandInput, TypingCommandPorts } from "./contracts";
import { withLogContext } from "../../logging";
import { Errors, type MatrixApiError } from "../../../../fatrix-model/utils/errors";
import { InfraError } from "../../domain-error";
import { fromInfraPromise, fromInfraVoid } from "../../effect/infra-effect";
import type { TypingEduContent } from "./contracts";

export interface TypingCommandEffectPorts {
  debugEnabled?: boolean | undefined;
  typingState: {
    setRoomTyping(
      roomId: string,
      userId: string,
      typing: boolean,
      timeoutMs?: number,
    ): Effect.Effect<void, InfraError>;
  };
  interestedServers: {
    listInterestedServers(roomId: string): Effect.Effect<string[], InfraError>;
  };
  federation: {
    queueTypingEdu(destination: string, content: TypingEduContent): Effect.Effect<void, InfraError>;
  };
}

export interface TypingRequestPorts extends TypingCommandEffectPorts {
  membership: {
    isUserJoinedToRoom(roomId: string, userId: string): Effect.Effect<boolean, InfraError>;
  };
}

function createCompatibilityTypingPorts(ports: TypingCommandPorts): TypingCommandEffectPorts {
  return {
    debugEnabled: ports.debugEnabled,
    typingState: {
      setRoomTyping: (roomId, userId, typing, timeoutMs) =>
        fromInfraVoid(
          () => Promise.resolve(ports.setRoomTyping(roomId, userId, typing, timeoutMs)),
          "Failed to update typing state",
        ),
    },
    interestedServers: {
      listInterestedServers: (roomId) =>
        fromInfraPromise(
          () => Promise.resolve(ports.resolveInterestedServers(roomId)),
          "Failed to resolve typing destinations",
        ),
    },
    federation: {
      queueTypingEdu: (destination, content) =>
        fromInfraVoid(
          () => Promise.resolve(ports.queueEdu(destination, content)),
          "Failed to queue typing EDU",
        ),
    },
  };
}

export function executeTypingCommandEffect(
  input: TypingCommandInput,
  ports: TypingCommandEffectPorts,
): Effect.Effect<void, InfraError> {
  const logger = withLogContext({
    component: "typing",
    operation: "command",
    room_id: input.roomId,
    user_id: input.userId,
    debugEnabled: ports.debugEnabled,
  });

  return Effect.gen(function* () {
    yield* logger.info("typing.command.start", {
      typing: input.typing,
      timeout_ms: input.timeoutMs,
    });

    yield* ports.typingState.setRoomTyping(
      input.roomId,
      input.userId,
      input.typing,
      input.timeoutMs,
    );

    const destinations = [
      ...new Set(yield* ports.interestedServers.listInterestedServers(input.roomId)),
    ];
    yield* logger.debug("typing.command.resolve_destinations", {
      destination_count: destinations.length,
      destinations,
    });
    if (destinations.length === 0) {
      yield* logger.info("typing.command.success", { destination_count: 0 });
      return;
    }

    const content: TypingEduContent = {
      room_id: input.roomId,
      user_id: input.userId,
      typing: input.typing,
      timeout: input.timeoutMs,
    };

    for (const destination of destinations) {
      yield* ports.federation.queueTypingEdu(destination, content);
    }

    yield* logger.info("typing.command.success", {
      destination_count: destinations.length,
    });
  });
}

export function executeTypingCommand(
  input: TypingCommandInput,
  ports: TypingCommandPorts,
): Promise<void> {
  return Effect.runPromise(
    executeTypingCommandEffect(input, createCompatibilityTypingPorts(ports)),
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

    yield* executeTypingCommandEffect(input, ports);
  });
}
