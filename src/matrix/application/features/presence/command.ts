import type { PresenceCommandInput, PresenceCommandPorts } from "./contracts";

export async function executePresenceCommand(
  input: PresenceCommandInput,
  ports: PresenceCommandPorts,
): Promise<void> {
  await ports.persistPresence(input);

  const interestedServers = await ports.resolveInterestedServers(input.userId);
  const destinations = [...new Set(interestedServers)].filter(
    (server) => server !== ports.localServerName,
  );
  console.log("[presence] interested remote servers", {
    userId: input.userId,
    destinations,
  });

  if (destinations.length === 0) {
    return;
  }

  const content = {
    push: [
      {
        user_id: input.userId,
        presence: input.presence,
        status_msg: input.statusMessage || undefined,
        last_active_ago: 0,
        currently_active: input.presence === "online",
      },
    ],
  };

  await Promise.all(destinations.map((destination) => ports.queueEdu(destination, content)));
}
