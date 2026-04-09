import { Effect } from "effect";
import type { RoomId, UserId } from "../../shared/types";
import { Errors, type MatrixApiError } from "../../shared/utils/errors";
import { parseRoomIdLike, parseUserIdLike } from "../../shared/utils/ids";

type ReceiptType = "m.read" | "m.read.private" | "m.fully_read";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseReceiptType(value: string): ReceiptType | null {
  return value === "m.read" || value === "m.read.private" || value === "m.fully_read"
    ? value
    : null;
}

function failInvalidParam(param: string, message: string): Effect.Effect<never, MatrixApiError> {
  return Effect.fail(Errors.invalidParam(param, message));
}

export interface SendReceiptInput {
  userId: UserId;
  roomId: RoomId;
  receiptType: ReceiptType;
  eventId: string;
  threadId?: string;
  now: number;
}

export interface SetReadMarkersInput {
  userId: UserId;
  roomId: RoomId;
  fullyRead?: string;
  read?: string;
  readPrivate?: string;
}

export function decodeSendReceiptInput(input: {
  authUserId: string;
  roomId: string;
  receiptType: string;
  eventId: string;
  body?: unknown;
  now: number;
}): Effect.Effect<SendReceiptInput, MatrixApiError> {
  return Effect.gen(function* () {
    const userId = parseUserIdLike(input.authUserId);
    if (!userId) {
      return yield* Effect.fail(Errors.unknownToken());
    }

    const roomId = parseRoomIdLike(input.roomId);
    if (!roomId) {
      return yield* failInvalidParam("room_id", "Invalid room ID");
    }

    const receiptType = parseReceiptType(input.receiptType);
    if (!receiptType) {
      return yield* failInvalidParam("receiptType", `Invalid receipt type: ${input.receiptType}`);
    }

    let threadId: string | undefined;
    if (input.body !== undefined) {
      if (!isRecord(input.body)) {
        return yield* Effect.fail(Errors.badJson());
      }

      const rawThreadId = input.body["thread_id"];
      if (rawThreadId !== undefined) {
        if (typeof rawThreadId !== "string") {
          return yield* failInvalidParam("thread_id", "thread_id must be a string");
        }
        threadId = rawThreadId;
      }
    }

    return {
      userId,
      roomId,
      receiptType,
      eventId: input.eventId,
      threadId,
      now: input.now,
    };
  });
}

export function decodeSetReadMarkersInput(input: {
  authUserId: string;
  roomId: string;
  body: unknown;
}): Effect.Effect<SetReadMarkersInput, MatrixApiError> {
  return Effect.gen(function* () {
    const userId = parseUserIdLike(input.authUserId);
    if (!userId) {
      return yield* Effect.fail(Errors.unknownToken());
    }

    const roomId = parseRoomIdLike(input.roomId);
    if (!roomId) {
      return yield* failInvalidParam("room_id", "Invalid room ID");
    }

    if (!isRecord(input.body)) {
      return yield* Effect.fail(Errors.badJson());
    }

    const fullyRead = input.body["m.fully_read"];
    const read = input.body["m.read"];
    const readPrivate = input.body["m.read.private"];

    if (fullyRead !== undefined && typeof fullyRead !== "string") {
      return yield* failInvalidParam("m.fully_read", "m.fully_read must be a string");
    }
    if (read !== undefined && typeof read !== "string") {
      return yield* failInvalidParam("m.read", "m.read must be a string");
    }
    if (readPrivate !== undefined && typeof readPrivate !== "string") {
      return yield* failInvalidParam("m.read.private", "m.read.private must be a string");
    }

    return {
      userId,
      roomId,
      ...(fullyRead !== undefined ? { fullyRead } : {}),
      ...(read !== undefined ? { read } : {}),
      ...(readPrivate !== undefined ? { readPrivate } : {}),
    };
  });
}
