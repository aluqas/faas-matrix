import type { PresenceCommandInput, PresenceCommandPorts } from "./contracts";
import { runClientEffect } from "../../effect-runtime";
import { withLogContext } from "../../logging";

export async function executePresenceCommand(
  input: PresenceCommandInput,
  ports: PresenceCommandPorts,
): Promise<void> {
  const logger = withLogContext({
    component: "presence",
    operation: "command",
    user_id: input.userId,
    debugEnabled: ports.debugEnabled,
  });

  await runClientEffect(
    logger.info("presence.command.start", {
      presence: input.presence,
      has_status_message: Boolean(input.statusMessage),
    }),
  );

  await ports.persistPresence(input);

  const interestedServers = await ports.resolveInterestedServers(input.userId);
  const destinations = [...new Set(interestedServers)].filter(
    (server) => server !== ports.localServerName,
  );
  await runClientEffect(
    logger.debug("presence.command.resolve_destinations", {
      destination_count: destinations.length,
      destinations,
    }),
  );

  if (destinations.length === 0) {
    await runClientEffect(logger.info("presence.command.success", { destination_count: 0 }));
    return;
  }

  const content = {
    push: [
      {
        user_id: input.userId,
        presence: input.presence,
        status_msg: input.statusMessage ?? undefined,
        last_active_ago: 0,
        currently_active: input.presence === "online",
      },
    ],
  };

  await Promise.all(destinations.map((destination) => ports.queueEdu(destination, content)));
  await runClientEffect(
    logger.info("presence.command.success", {
      destination_count: destinations.length,
    }),
  );
}
