import { Effect } from "effect";
import { InfraError } from "../../matrix/application/domain-error";
import { fromInfraPromise, fromInfraVoid } from "../../shared/effect/infra-effect";
import { extractServerNameFromMatrixId } from "../shared/matrix-id";
import type { TypingEduContent, TypingIngestPorts } from "./contracts";

export interface TypingIngestEffectPorts {
  membership: {
    getMembership(roomId: string, userId: string): Effect.Effect<string | null, InfraError>;
    isPartialStateRoom?(roomId: string): Effect.Effect<boolean, InfraError>;
  };
  typingState: {
    setRoomTyping(
      roomId: string,
      userId: string,
      typing: boolean,
      timeoutMs?: number,
    ): Effect.Effect<void, InfraError>;
  };
}

function createCompatibilityTypingIngestPorts(ports: TypingIngestPorts): TypingIngestEffectPorts {
  return {
    membership: {
      getMembership: (roomId, userId) =>
        fromInfraPromise(
          () => Promise.resolve(ports.getMembership(roomId, userId)),
          "Failed to check typing EDU membership",
        ),
      isPartialStateRoom: ports.isPartialStateRoom
        ? (roomId) =>
            fromInfraPromise(
              () => Promise.resolve(ports.isPartialStateRoom!(roomId)),
              "Failed to check typing EDU partial-state room",
            )
        : undefined,
    },
    typingState: {
      setRoomTyping: (roomId, userId, typing, timeoutMs) =>
        fromInfraVoid(
          () => Promise.resolve(ports.setRoomTyping(roomId, userId, typing, timeoutMs)),
          "Failed to apply typing EDU",
        ),
    },
  };
}

export function ingestTypingEduEffect(
  origin: string,
  content: TypingEduContent,
  ports: TypingIngestEffectPorts,
): Effect.Effect<void, InfraError> {
  return Effect.gen(function* () {
    const roomId = content.room_id;
    const userId = content.user_id;
    const typing = content.typing;
    const timeoutMs =
      typeof content.timeout === "number" && content.timeout > 0 ? content.timeout : undefined;

    if (!roomId || !userId || typing === undefined) {
      return;
    }

    if (extractServerNameFromMatrixId(userId) !== origin) {
      return;
    }

    const membership = yield* ports.membership.getMembership(roomId, userId);
    const partialStateRoom = ports.membership.isPartialStateRoom
      ? yield* ports.membership.isPartialStateRoom(roomId)
      : false;
    if (membership !== "join" && !partialStateRoom) {
      return;
    }

    yield* ports.typingState.setRoomTyping(roomId, userId, typing, timeoutMs);
  });
}

export async function ingestTypingEdu(
  origin: string,
  content: TypingEduContent,
  ports: TypingIngestPorts,
): Promise<void> {
  await Effect.runPromise(
    ingestTypingEduEffect(origin, content, createCompatibilityTypingIngestPorts(ports)),
  );
}
