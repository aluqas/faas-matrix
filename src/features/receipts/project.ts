import type { Env, RoomId } from "../../shared/types";
import { isJsonObject } from "../../shared/types/common";
import { getRoomReceiptState } from "../shared/room-do-gateway";

export type ReceiptContent = Record<
  string,
  Record<string, Record<string, { ts: number; thread_id?: string }>>
>;

export interface ReceiptEvent {
  type: "m.receipt";
  content: ReceiptContent;
}

function parseReceiptContent(value: unknown): ReceiptContent {
  if (!isJsonObject(value)) {
    return {};
  }

  const parsed: ReceiptContent = {};
  for (const [eventId, receiptTypes] of Object.entries(value)) {
    if (!isJsonObject(receiptTypes)) {
      continue;
    }
    const parsedTypes: ReceiptContent[string] = {};

    for (const [receiptType, users] of Object.entries(receiptTypes)) {
      if (!isJsonObject(users)) {
        continue;
      }
      const parsedUsers: ReceiptContent[string][string] = {};

      for (const [userId, receipt] of Object.entries(users)) {
        if (!isJsonObject(receipt) || typeof receipt.ts !== "number") {
          continue;
        }
        parsedUsers[userId] =
          typeof receipt.thread_id === "string"
            ? { ts: receipt.ts, thread_id: receipt.thread_id }
            : { ts: receipt.ts };
      }

      parsedTypes[receiptType] = parsedUsers;
    }

    parsed[eventId] = parsedTypes;
  }

  return parsed;
}

function filterPrivateReceipts(
  receipts: ReceiptContent,
  requestingUserId?: string,
): ReceiptContent {
  if (!requestingUserId) {
    return receipts;
  }

  const filteredReceipts: ReceiptContent = {};

  for (const [eventId, receiptTypes] of Object.entries(receipts)) {
    filteredReceipts[eventId] = {};

    for (const [receiptType, users] of Object.entries(receiptTypes)) {
      if (receiptType === "m.read.private") {
        if (users[requestingUserId]) {
          filteredReceipts[eventId][receiptType] = {
            [requestingUserId]: users[requestingUserId],
          };
        }
      } else {
        filteredReceipts[eventId][receiptType] = users;
      }
    }

    if (Object.keys(filteredReceipts[eventId]).length === 0) {
      delete filteredReceipts[eventId];
    }
  }

  return filteredReceipts;
}

export async function getReceiptsForRoom(
  env: Pick<Env, "ROOMS">,
  roomId: RoomId,
  requestingUserId?: string,
): Promise<ReceiptEvent> {
  const data = await getRoomReceiptState(env, roomId);
  const receipts = isJsonObject(data) ? parseReceiptContent(data.receipts) : {};

  return {
    type: "m.receipt",
    content: filterPrivateReceipts(receipts, requestingUserId),
  };
}

export async function getReceiptsForRooms(
  env: Pick<Env, "ROOMS">,
  roomIds: RoomId[],
  requestingUserId?: string,
): Promise<Record<RoomId, ReceiptContent>> {
  if (roomIds.length === 0) {
    return {};
  }

  const results = await Promise.all(
    roomIds.map(async (roomId) => {
      try {
        const receipts = await getReceiptsForRoom(env, roomId, requestingUserId);
        return { roomId, content: receipts.content };
      } catch {
        return { roomId, content: {} };
      }
    }),
  );

  const byRoom: Partial<Record<RoomId, ReceiptContent>> = {};
  for (const { roomId, content } of results) {
    if (Object.keys(content).length > 0) {
      byRoom[roomId] = content;
    }
  }

  return byRoom as Record<RoomId, ReceiptContent>;
}
