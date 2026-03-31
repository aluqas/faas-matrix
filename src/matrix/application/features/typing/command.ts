import type { TypingCommandInput, TypingCommandPorts } from "./contracts";
import { runClientEffect } from "../../effect-runtime";
import { withLogContext } from "../../logging";

export async function executeTypingCommand(
  input: TypingCommandInput,
  ports: TypingCommandPorts,
): Promise<void> {
  const logger = withLogContext({
    component: "typing",
    operation: "command",
    room_id: input.roomId,
    user_id: input.userId,
    debugEnabled: ports.debugEnabled,
  });

  await runClientEffect(
    logger.info("typing.command.start", {
      typing: input.typing,
      timeout_ms: input.timeoutMs,
    }),
  );

  await ports.setRoomTyping(input.roomId, input.userId, input.typing, input.timeoutMs);

  const destinations = [...new Set(await ports.resolveInterestedServers(input.roomId))];
  await runClientEffect(
    logger.debug("typing.command.resolve_destinations", {
      destination_count: destinations.length,
      destinations,
    }),
  );
  if (destinations.length === 0) {
    await runClientEffect(logger.info("typing.command.success", { destination_count: 0 }));
    return;
  }

  const content = {
    room_id: input.roomId,
    user_id: input.userId,
    typing: input.typing,
    timeout: input.timeoutMs,
  };

  await Promise.all(destinations.map((destination) => ports.queueEdu(destination, content)));
  await runClientEffect(
    logger.info("typing.command.success", {
      destination_count: destinations.length,
    }),
  );
}
