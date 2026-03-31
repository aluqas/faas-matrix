import { extractServerNameFromMatrixId } from "../shared/matrix-id";
import type { TypingEduContent, TypingIngestPorts } from "./contracts";

export async function ingestTypingEdu(
  origin: string,
  content: TypingEduContent,
  ports: TypingIngestPorts,
): Promise<void> {
  const roomId = content.room_id;
  const userId = content.user_id;
  const typing = content.typing;
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
