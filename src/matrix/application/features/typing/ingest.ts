import { extractServerNameFromMatrixId } from "../shared/matrix-id";
import type { TypingIngestPorts } from "./contracts";

export async function ingestTypingEdu(
  origin: string,
  content: Record<string, unknown>,
  ports: TypingIngestPorts,
): Promise<void> {
  const roomId = typeof content.room_id === "string" ? content.room_id : undefined;
  const userId = typeof content.user_id === "string" ? content.user_id : undefined;
  const typing = typeof content.typing === "boolean" ? content.typing : undefined;
  const timeoutMs =
    typeof content.timeout === "number" && content.timeout > 0 ? content.timeout : undefined;

  if (!roomId || !userId || typing === undefined) {
    return;
  }

  if (extractServerNameFromMatrixId(userId) !== origin) {
    return;
  }

  const membership = await ports.getMembership(roomId, userId);
  if (membership !== "join") {
    return;
  }

  await ports.setRoomTyping(roomId, userId, typing, timeoutMs);
}
