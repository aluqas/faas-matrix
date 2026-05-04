import { Effect } from "effect";
import type { RoomId, UserId } from "../../../../fatrix-model/types";
import { Errors, MatrixApiError } from "../../../../fatrix-model/utils/errors";
import { InfraError } from "../../domain-error";

export interface ReceiptsCommandPorts {
  membership: {
    isUserJoinedToRoom(roomId: RoomId, userId: UserId): Effect.Effect<boolean, InfraError>;
  };
  fullyReadStore: {
    putFullyRead(userId: UserId, roomId: RoomId, eventId: string): Effect.Effect<void, InfraError>;
  };
  roomReceiptStore: {
    putReceipt(
      roomId: RoomId,
      userId: UserId,
      eventId: string,
      receiptType: string,
      threadId?: string,
      ts?: number,
    ): Effect.Effect<void, InfraError>;
  };
  federation: {
    listJoinedServers(roomId: RoomId): Effect.Effect<string[], InfraError>;
    queueReceipt(
      destination: string,
      content: Record<string, unknown>,
    ): Effect.Effect<void, InfraError>;
  };
}

export function sendReceiptEffect(
  ports: ReceiptsCommandPorts,
  input: {
    userId: UserId;
    roomId: RoomId;
    receiptType: "m.read" | "m.read.private" | "m.fully_read";
    eventId: string;
    threadId?: string;
    now: number;
  },
): Effect.Effect<void, MatrixApiError | InfraError> {
  return Effect.gen(function* () {
    const joined = yield* ports.membership.isUserJoinedToRoom(input.roomId, input.userId);
    if (!joined) {
      return yield* Effect.fail(Errors.forbidden("Not a member of this room"));
    }

    if (input.receiptType === "m.fully_read") {
      yield* ports.fullyReadStore.putFullyRead(input.userId, input.roomId, input.eventId);
      return;
    }

    yield* ports.roomReceiptStore.putReceipt(
      input.roomId,
      input.userId,
      input.eventId,
      input.receiptType,
      input.threadId,
      input.now,
    );

    if (input.receiptType === "m.read") {
      const destinations = yield* ports.federation.listJoinedServers(input.roomId);
      for (const destination of destinations) {
        yield* ports.federation.queueReceipt(destination, {
          [input.roomId]: {
            "m.read": {
              [input.userId]: {
                event_ids: [input.eventId],
                data: {
                  ts: input.now,
                  ...(input.threadId ? { thread_id: input.threadId } : {}),
                },
              },
            },
          },
        });
      }
    }

    if (input.receiptType === "m.read" && input.threadId === undefined) {
      yield* ports.fullyReadStore.putFullyRead(input.userId, input.roomId, input.eventId);
    }
  });
}

export function setReadMarkersEffect(
  ports: ReceiptsCommandPorts,
  input: {
    userId: UserId;
    roomId: RoomId;
    fullyRead?: string;
    read?: string;
    readPrivate?: string;
  },
): Effect.Effect<void, MatrixApiError | InfraError> {
  return Effect.gen(function* () {
    const joined = yield* ports.membership.isUserJoinedToRoom(input.roomId, input.userId);
    if (!joined) {
      return yield* Effect.fail(Errors.forbidden("Not a member of this room"));
    }

    if (input.fullyRead) {
      yield* ports.fullyReadStore.putFullyRead(input.userId, input.roomId, input.fullyRead);
    }

    if (input.read) {
      yield* ports.roomReceiptStore.putReceipt(input.roomId, input.userId, input.read, "m.read");
      if (!input.fullyRead) {
        yield* ports.fullyReadStore.putFullyRead(input.userId, input.roomId, input.read);
      }
    }

    if (input.readPrivate) {
      yield* ports.roomReceiptStore.putReceipt(
        input.roomId,
        input.userId,
        input.readPrivate,
        "m.read.private",
      );
    }
  });
}
