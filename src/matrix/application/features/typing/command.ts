import type { TypingCommandInput, TypingCommandPorts } from "./contracts";

export async function executeTypingCommand(
  input: TypingCommandInput,
  ports: TypingCommandPorts,
): Promise<void> {
  await ports.setRoomTyping(input.roomId, input.userId, input.typing, input.timeoutMs);

  const destinations = [...new Set(await ports.resolveInterestedServers(input.roomId))];
  console.log("[typing] interested remote servers", {
    roomId: input.roomId,
    userId: input.userId,
    destinations,
  });
  if (destinations.length === 0) {
    return;
  }

  const content = {
    room_id: input.roomId,
    user_id: input.userId,
    typing: input.typing,
    timeout: input.timeoutMs,
  };

  await Promise.all(destinations.map((destination) => ports.queueEdu(destination, content)));
}
