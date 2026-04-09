import { Effect } from "effect";
import type { FilterDefinition } from "../../infra/repositories/interfaces";
import type { RoomId } from "../../shared/types/matrix";
import { InfraError } from "../../matrix/application/domain-error";
import type { PartialStatePort } from "./effect-ports";
import type { RoomVisibilityContext } from "./contracts";

export function lazyLoadAllowsPartialStateRooms(
  filter: FilterDefinition | null | undefined,
): boolean {
  return (
    filter?.room?.timeline?.lazy_load_members === true ||
    filter?.room?.state?.lazy_load_members === true
  );
}

/**
 * Builds {@link RoomVisibilityContext} inside the Effect stack (no `runPromise` in callers).
 */
export function buildRoomVisibilityContextEffect(
  partialState: PartialStatePort,
  input: {
    userId: string;
    visibleJoinedRoomIds: readonly RoomId[];
    filter: FilterDefinition | null;
  },
): Effect.Effect<RoomVisibilityContext, InfraError> {
  return Effect.gen(function* () {
    const exposePartial = lazyLoadAllowsPartialStateRooms(input.filter);
    const forceFullStateRooms = new Set<RoomId>();
    const hiddenPartialStateRooms = new Set<RoomId>();
    const visiblePartialStateRooms = new Set<RoomId>();

    for (const roomId of input.visibleJoinedRoomIds) {
      const partialStateStatus = yield* partialState.getPartialStateStatus(input.userId, roomId);
      const partialStateCompletion = yield* partialState.takePartialStateCompletionStatus(
        input.userId,
        roomId,
      );
      if (partialStateCompletion) {
        forceFullStateRooms.add(roomId);
      }
      if (partialStateStatus && partialStateStatus.phase !== "complete" && !exposePartial) {
        hiddenPartialStateRooms.add(roomId);
      }
      if (partialStateStatus && partialStateStatus.phase !== "complete") {
        visiblePartialStateRooms.add(roomId);
      }
    }

    return {
      visibleJoinedRoomIds: [...input.visibleJoinedRoomIds],
      hiddenPartialStateRooms,
      visiblePartialStateRooms,
      forceFullStateRooms,
    };
  });
}
