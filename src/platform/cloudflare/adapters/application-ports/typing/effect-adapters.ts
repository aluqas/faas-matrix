import type { Env } from "../../../env";
import type { RealtimeCapability } from "../../../../../fatrix-backend/ports/runtime/runtime-capabilities";
import { fromInfraPromise, fromInfraVoid } from "../../../../../fatrix-backend/application/effect/infra-effect";
import {
  isUserJoinedToRealtimeRoom,
  listRemoteJoinedServersInRoom,
} from "../../repositories/realtime-room-repository";
import { getEffectiveMembershipForRealtimeUser } from "../../repositories/federation-state-repository";
import { toRoomId, toUserId } from "../../../../../fatrix-model/utils/ids";
import { queueFederationEdu } from "../shared/federation-edu-queue";
import { setRoomTypingState } from "../shared/room-do-gateway";
import { getPartialStateJoinForRoom } from "../../../../../fatrix-backend/application/features/partial-state/tracker";
import type { TypingRequestPorts } from "../../../../../fatrix-backend/application/features/typing/command";
import type { TypingIngestEffectPorts } from "../../../../../fatrix-backend/application/features/typing/ingest";

export function createTypingRequestPorts(
  env: Pick<Env, "DB" | "ROOMS" | "SERVER_NAME"> & Env,
  debugEnabled: boolean,
): TypingRequestPorts {
  return {
    debugEnabled,
    membership: {
      isUserJoinedToRoom: (roomId, userId) =>
        fromInfraPromise(
          () => isUserJoinedToRealtimeRoom(env.DB, toRoomId(roomId), toUserId(userId)),
          "Failed to check typing membership",
        ),
    },
    typingState: {
      setRoomTyping: (roomId, userId, typing, timeoutMs = 30000) =>
        fromInfraVoid(
          () => setRoomTypingState(env, toRoomId(roomId), toUserId(userId), typing, timeoutMs),
          "Failed to update typing state",
        ),
    },
    interestedServers: {
      listInterestedServers: (roomId) =>
        fromInfraPromise(
          () => listRemoteJoinedServersInRoom(env.DB, toRoomId(roomId), env.SERVER_NAME),
          "Failed to resolve typing destinations",
        ),
    },
    federation: {
      queueTypingEdu: (destination, content) =>
        fromInfraVoid(
          () =>
            queueFederationEdu(
              env,
              destination,
              "m.typing",
              content as unknown as Record<string, unknown>,
            ),
          "Failed to queue typing EDU",
        ),
    },
  };
}

export function createFederationTypingIngestPorts(input: {
  db: D1Database;
  realtime: RealtimeCapability;
  cache?: KVNamespace | undefined;
}): TypingIngestEffectPorts {
  return {
    membership: {
      getMembership: (roomId, userId) =>
        fromInfraPromise(
          () => getEffectiveMembershipForRealtimeUser(input.db, roomId, userId),
          "Failed to check typing EDU membership",
        ),
      isPartialStateRoom: (roomId) =>
        fromInfraPromise(async () => {
          const typedRoomId = toRoomId(roomId);
          return typedRoomId
            ? (await getPartialStateJoinForRoom(input.cache, typedRoomId)) !== null
            : false;
        }, "Failed to check typing EDU partial-state room"),
    },
    typingState: {
      setRoomTyping: (roomId, userId, typing, timeoutMs) =>
        fromInfraVoid(async () => {
          const typedRoomId = toRoomId(roomId);
          const typedUserId = toUserId(userId);
          if (!typedRoomId || !typedUserId) {
            return;
          }
          await input.realtime.setRoomTyping?.(typedRoomId, typedUserId, typing, timeoutMs);
        }, "Failed to apply typing EDU"),
    },
  };
}
