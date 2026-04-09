import type { AppEnv } from "../../shared/types";
import { fromInfraPromise } from "../../shared/effect/infra-effect";
import { listRemoteJoinedServersInRoom } from "../../infra/repositories/realtime-room-repository";
import { isUserJoinedToRealtimeRoom } from "../../infra/repositories/realtime-room-repository";
import { toRoomId, toUserId } from "../../shared/utils/ids";
import { queueFederationEdu } from "../shared/federation-edu-queue";
import { setRoomTypingState } from "../shared/room-do-gateway";
import type { TypingCommandPorts } from "./contracts";
import { executeTypingCommand, type TypingRequestPorts } from "./command";

function createAsyncTypingCommandPorts(
  env: Pick<AppEnv["Bindings"], "DB" | "ROOMS" | "SERVER_NAME"> & AppEnv["Bindings"],
  debugEnabled: boolean,
): TypingCommandPorts {
  return {
    setRoomTyping: (roomId, userId, typing, timeoutMs = 30000) =>
      setRoomTypingState(env, toRoomId(roomId), toUserId(userId), typing, timeoutMs),
    resolveInterestedServers: (roomId) =>
      listRemoteJoinedServersInRoom(env.DB, toRoomId(roomId), env.SERVER_NAME),
    queueEdu: (destination, content) => queueFederationEdu(env, destination, "m.typing", content),
    debugEnabled,
  };
}

export function createTypingRequestPorts(
  env: Pick<AppEnv["Bindings"], "DB" | "ROOMS" | "SERVER_NAME"> & AppEnv["Bindings"],
  debugEnabled: boolean,
): TypingRequestPorts {
  return {
    membership: {
      isUserJoinedToRoom: (roomId, userId) =>
        fromInfraPromise(
          () => isUserJoinedToRealtimeRoom(env.DB, toRoomId(roomId), toUserId(userId)),
          "Failed to check typing membership",
        ),
    },
    executor: {
      execute: (input) =>
        fromInfraPromise(
          () => executeTypingCommand(input, createAsyncTypingCommandPorts(env, debugEnabled)),
          "Failed to update typing state",
        ),
    },
  };
}
