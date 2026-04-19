import { Effect } from "effect";
import { InfraError } from "../../matrix/application/domain-error";
import type { EventId, RoomId, UserId } from "../../shared/types";
import { toEventId, toRoomId, toUserId } from "../../shared/utils/ids";
import { extractServerNameFromMatrixId } from "../../shared/utils/matrix-ids";

export interface ReceiptIngestPorts {
  membership: {
    getMembership(roomId: string, userId: string): Effect.Effect<string | null, InfraError>;
    isPartialStateRoom(roomId: RoomId): Effect.Effect<boolean, InfraError>;
  };
  roomReceiptStore: {
    putReceipt(
      roomId: RoomId,
      userId: UserId,
      eventId: EventId,
      receiptType: string,
      threadId?: string,
      ts?: number,
    ): Effect.Effect<void, InfraError>;
  };
}

export interface ReceiptIngestInput {
  origin: string;
  content: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function getReceiptEventId(receipt: Record<string, unknown>): string | undefined {
  const eventIds = Array.isArray(receipt["event_ids"])
    ? receipt["event_ids"].filter((eventId): eventId is string => typeof eventId === "string")
    : [];
  return eventIds[0];
}

export function ingestReceiptEduEffect(
  ports: ReceiptIngestPorts,
  input: ReceiptIngestInput,
): Effect.Effect<void, InfraError> {
  return Effect.gen(function* () {
    for (const [roomId, receiptsByType] of Object.entries(input.content)) {
      if (!isRecord(receiptsByType)) {
        continue;
      }

      const typedRoomId = toRoomId(roomId);
      const partialStateRoom = typedRoomId
        ? yield* ports.membership.isPartialStateRoom(typedRoomId)
        : false;

      for (const [receiptType, receiptsByUser] of Object.entries(receiptsByType)) {
        if (!isRecord(receiptsByUser)) {
          continue;
        }

        for (const [userId, receipt] of Object.entries(receiptsByUser)) {
          if (extractServerNameFromMatrixId(userId) !== input.origin || !isRecord(receipt)) {
            continue;
          }

          const eventId = getReceiptEventId(receipt);
          if (!eventId) {
            continue;
          }

          const membership = yield* ports.membership.getMembership(roomId, userId);
          if (membership !== "join" && !partialStateRoom) {
            continue;
          }

          const data = isRecord(receipt["data"]) ? receipt["data"] : {};
          const ts = typeof data["ts"] === "number" ? data["ts"] : undefined;
          const threadId = typeof data["thread_id"] === "string" ? data["thread_id"] : undefined;
          const typedUserId = toUserId(userId);
          const typedEventId = toEventId(eventId);
          if (!typedRoomId || !typedUserId || !typedEventId) {
            continue;
          }

          yield* ports.roomReceiptStore.putReceipt(
            typedRoomId,
            typedUserId,
            typedEventId,
            receiptType,
            threadId,
            ts,
          );
        }
      }
    }
  });
}
