import type { RoomId } from "../../../../../fatrix-model/types";
import { isJsonObject } from "../../../../../fatrix-model/types/common";
import type { Env } from "../../../env";
import {
  filterPrivateReceipts,
  parseReceiptContent,
  type ReceiptContent,
  type ReceiptEvent,
} from "../../../../../fatrix-backend/application/features/receipts/project";
import { getRoomReceiptState } from "../shared/room-do-gateway";

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
