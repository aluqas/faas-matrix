import type { PDU } from "../types";
import { federationPut } from "./federation-keys";

export async function fanoutEventToRemoteServers(
  db: D1Database,
  cache: KVNamespace,
  localServerName: string,
  roomId: string,
  event: PDU,
): Promise<void> {
  const members = await db
    .prepare(
      `SELECT DISTINCT user_id FROM room_memberships WHERE room_id = ? AND membership = 'join'`,
    )
    .bind(roomId)
    .all<{ user_id: string }>();

  const remoteServers = new Set<string>();
  for (const member of members.results) {
    const parts = member.user_id.split(":");
    const server = parts[parts.length - 1];
    if (server && server !== localServerName) {
      remoteServers.add(server);
    }
  }

  const roomIdParts = roomId.split(":");
  const roomServer = roomIdParts[roomIdParts.length - 1];
  if (roomServer && roomServer !== localServerName && event.type === "m.room.member") {
    remoteServers.add(roomServer);
  }

  if (event.type === "m.room.member" && event.state_key) {
    const membership =
      event.content && typeof event.content === "object" && "membership" in event.content
        ? event.content.membership
        : undefined;

    if (membership !== "invite" && membership !== "knock") {
      const parts = event.state_key.split(":");
      const targetServer = parts[parts.length - 1];
      if (targetServer && targetServer !== localServerName) {
        remoteServers.add(targetServer);
      }
    }
  }

  if (remoteServers.size === 0) {
    return;
  }

  const txnId = `${Date.now()}-${event.event_id.substring(0, 8)}`;
  const body = { pdus: [event] };

  await Promise.all(
    Array.from(remoteServers).map(async (server) => {
      try {
        await federationPut(
          server,
          `/_matrix/federation/v1/send/${encodeURIComponent(txnId)}`,
          body,
          localServerName,
          db,
          cache,
        );
      } catch (error) {
        console.error(`[federation-fanout] Failed to send to ${server}:`, error);
      }
    }),
  );
}
