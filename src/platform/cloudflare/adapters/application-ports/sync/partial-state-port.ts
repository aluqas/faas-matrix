import { Effect } from "effect";
import {
  getPersistedPartialStateCompletionStatus,
  getPersistedPartialStateStatus,
  takePersistedPartialStateCompletionStatus,
} from "../../../../../fatrix-backend/application/features/partial-state/shared-servers";
import {
  consumePartialStateCompletionStatus,
  getPartialStateCompletionStatus,
  getPartialStateStatus,
} from "../../../../../fatrix-backend/application/features/partial-state/tracker";
import { toRoomId, toUserId } from "../../../../../fatrix-model/utils/ids";
import type { PartialStatePort } from "../../../../../fatrix-backend/application/features/sync/ports/effect-ports";
import { toInfraError } from "../../../../../fatrix-backend/application/features/sync/ports/effect-ports";

export function createEffectPartialStatePort(
  db: D1Database,
  cache: KVNamespace | undefined,
): PartialStatePort {
  return {
    getPartialStateStatus: (userId, roomId) =>
      Effect.tryPromise({
        try: async () => {
          const typedUserId = toUserId(userId);
          const typedRoomId = toRoomId(roomId);
          if (!typedUserId || !typedRoomId) {
            return null;
          }
          return (
            (await getPartialStateStatus(cache, typedUserId, typedRoomId)) ??
            getPersistedPartialStateStatus(db, typedUserId, typedRoomId)
          );
        },
        catch: (cause) => toInfraError("Failed to load partial-state status", cause),
      }),
    getPartialStateCompletionStatus: (userId, roomId) =>
      Effect.tryPromise({
        try: async () => {
          const typedUserId = toUserId(userId);
          const typedRoomId = toRoomId(roomId);
          if (!typedUserId || !typedRoomId) {
            return null;
          }
          return (
            (await getPartialStateCompletionStatus(cache, typedUserId, typedRoomId)) ??
            getPersistedPartialStateCompletionStatus(db, typedUserId, typedRoomId)
          );
        },
        catch: (cause) => toInfraError("Failed to load partial-state completion status", cause),
      }),
    takePartialStateCompletionStatus: (userId, roomId) =>
      Effect.tryPromise({
        try: async () => {
          const typedUserId = toUserId(userId);
          const typedRoomId = toRoomId(roomId);
          if (!typedUserId || !typedRoomId) {
            return null;
          }
          return (
            (await consumePartialStateCompletionStatus(cache, typedUserId, typedRoomId)) ??
            takePersistedPartialStateCompletionStatus(db, typedUserId, typedRoomId)
          );
        },
        catch: (cause) => toInfraError("Failed to consume partial-state completion status", cause),
      }),
  };
}
