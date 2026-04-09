import type { Env, RoomId, UserId } from "../../shared/types";

function getRoomDO(env: Pick<Env, "ROOMS">, roomId: RoomId): DurableObjectStub {
  const id = env.ROOMS.idFromName(roomId);
  return env.ROOMS.get(id);
}

export async function setRoomTypingState(
  env: Pick<Env, "ROOMS">,
  roomId: RoomId,
  userId: UserId,
  typing: boolean,
  timeoutMs: number = 30000,
): Promise<void> {
  const roomDO = getRoomDO(env, roomId);
  await roomDO.fetch(
    new Request("https://room/typing", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: userId,
        typing,
        timeout: timeoutMs,
      }),
    }),
  );
}

export async function getRoomTypingState(
  env: Pick<Env, "ROOMS">,
  roomId: RoomId,
): Promise<unknown> {
  const roomDO = getRoomDO(env, roomId);
  const response = await roomDO.fetch(
    new Request("https://room/typing", {
      method: "GET",
    }),
  );
  return response.json();
}

export async function setRoomReceiptState(
  env: Pick<Env, "ROOMS">,
  roomId: RoomId,
  userId: UserId,
  eventId: string,
  receiptType: string,
  threadId?: string,
  ts?: number,
): Promise<void> {
  const roomDO = getRoomDO(env, roomId);
  await roomDO.fetch(
    new Request("https://room/receipt", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: userId,
        event_id: eventId,
        receipt_type: receiptType,
        ...(threadId ? { thread_id: threadId } : {}),
        ...(ts !== undefined ? { ts } : {}),
      }),
    }),
  );
}

export async function getRoomReceiptState(
  env: Pick<Env, "ROOMS">,
  roomId: RoomId,
): Promise<unknown> {
  const roomDO = getRoomDO(env, roomId);
  const response = await roomDO.fetch(
    new Request("https://room/receipts", {
      method: "GET",
    }),
  );
  return response.json();
}
