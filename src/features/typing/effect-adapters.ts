import type { AppEnv } from "../../shared/types";
import type { RealtimeCapability } from "../../shared/runtime/runtime-capabilities";
import { fromInfraPromise, fromInfraVoid } from "../../shared/effect/infra-effect";
import { listRemoteJoinedServersInRoom } from "../../infra/repositories/realtime-room-repository";
import { isUserJoinedToRealtimeRoom } from "../../infra/repositories/realtime-room-repository";
import { toRoomId, toUserId } from "../../shared/utils/ids";
import { queueFederationEdu } from "../shared/federation-edu-queue";
import { setRoomTypingState } from "../shared/room-do-gateway";
import { getEffectiveMembershipForRealtimeUser } from "../../infra/repositories/federation-state-repository";
import { getPartialStateJoinForRoom } from "../partial-state/tracker";
import type { TypingRequestPorts } from "./command";
import type { TypingIngestEffectPorts } from "./ingest";

export function createTypingRequestPorts(
  env: Pick<AppEnv["Bindings"], "DB" | "ROOMS" | "SERVER_NAME"> & AppEnv["Bindings"],
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
