import { isJsonObject } from "../../../../fatrix-model/types/common";

export type ReceiptContent = Record<
  string,
  Record<string, Record<string, { ts: number; thread_id?: string }>>
>;

export interface ReceiptEvent {
  type: "m.receipt";
  content: ReceiptContent;
}

export function parseReceiptContent(value: unknown): ReceiptContent {
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

export function filterPrivateReceipts(
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
