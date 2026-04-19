import type { AppEnv } from "../../shared/types";
import type { RealtimeCapability } from "../../shared/runtime/runtime-capabilities";
import { fromInfraPromise, fromInfraVoid } from "../../shared/effect/infra-effect";
import { upsertAccountDataRecord } from "../../infra/repositories/account-data-repository";
import { getEffectiveMembershipForRealtimeUser } from "../../infra/repositories/federation-state-repository";
import {
  isUserJoinedToRealtimeRoom,
  listRemoteJoinedServersInRoom,
} from "../../infra/repositories/realtime-room-repository";
import { toRoomId } from "../../shared/utils/ids";
import { getPartialStateJoinForRoom } from "../partial-state/tracker";
import { queueFederationEdu } from "../shared/federation-edu-queue";
import { setRoomReceiptState } from "../shared/room-do-gateway";
import type { ReceiptsCommandPorts } from "./command";
import type { ReceiptIngestPorts } from "./ingest";

export function createReceiptsCommandPorts(
  env: Pick<AppEnv["Bindings"], "DB" | "ROOMS" | "SERVER_NAME"> & AppEnv["Bindings"],
): ReceiptsCommandPorts {
  return {
    membership: {
      isUserJoinedToRoom: (roomId, userId) =>
        fromInfraPromise(
          () => isUserJoinedToRealtimeRoom(env.DB, roomId, userId),
          "Failed to check receipt membership",
        ),
    },
    fullyReadStore: {
      putFullyRead: (userId, roomId, eventId) =>
        fromInfraVoid(
          () =>
            upsertAccountDataRecord(
              env.DB,
              userId,
              roomId,
              "m.fully_read",
              JSON.stringify({ event_id: eventId }),
            ),
          "Failed to store fully-read marker",
        ),
    },
    roomReceiptStore: {
      putReceipt: (roomId, userId, eventId, receiptType, threadId, ts) =>
        fromInfraVoid(
          () => setRoomReceiptState(env, roomId, userId, eventId, receiptType, threadId, ts),
          "Failed to store room receipt",
        ),
    },
    federation: {
      listJoinedServers: (roomId) =>
        fromInfraPromise(
          () => listRemoteJoinedServersInRoom(env.DB, roomId, env.SERVER_NAME),
          "Failed to list receipt destinations",
        ),
      queueReceipt: (destination, content) =>
        fromInfraVoid(
          () => queueFederationEdu(env, destination, "m.receipt", content),
          "Failed to queue receipt EDU",
        ),
    },
  };
}

export function createFederationReceiptIngestPorts(input: {
  db: D1Database;
  realtime: RealtimeCapability;
  cache?: KVNamespace | undefined;
}): ReceiptIngestPorts {
  return {
    membership: {
      getMembership: (roomId, userId) =>
        fromInfraPromise(
          () => getEffectiveMembershipForRealtimeUser(input.db, roomId, userId),
          "Failed to check receipt EDU membership",
        ),
      isPartialStateRoom: (roomId) =>
        fromInfraPromise(
          async () => (await getPartialStateJoinForRoom(input.cache, roomId)) !== null,
          "Failed to check receipt EDU partial-state room",
        ),
    },
    roomReceiptStore: {
      putReceipt: (roomId, userId, eventId, receiptType, threadId, ts) =>
        fromInfraVoid(async () => {
          const typedRoomId = toRoomId(roomId);
          if (!typedRoomId) {
            return;
          }
          await input.realtime.setRoomReceipt?.(
            typedRoomId,
            userId,
            eventId,
            receiptType,
            threadId,
            ts,
          );
        }, "Failed to apply receipt EDU"),
    },
  };
}
