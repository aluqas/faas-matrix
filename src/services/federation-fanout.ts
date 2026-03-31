import type { PDU } from "../types";
import { federationPut } from "./federation-keys";

type MembershipServerRow = {
  user_id: string;
  membership: string;
};

function extractServerName(id: string | undefined): string | null {
  if (!id) {
    return null;
  }
  const parts = id.split(":");
  return parts[parts.length - 1] || null;
}

export function collectRemoteServersForEvent(
  localServerName: string,
  roomId: string,
  event: PDU,
  memberships: MembershipServerRow[],
): string[] {
  const remoteServers = new Set<string>();

  for (const member of memberships) {
    const server = extractServerName(member.user_id);
    if (!server || server === localServerName) {
      continue;
    }

    if (member.membership === "join" || member.membership === "invite" || member.membership === "knock") {
      remoteServers.add(server);
      continue;
    }

    if (event.type === "m.room.server_acl" && member.membership !== "leave") {
      remoteServers.add(server);
    }
  }

  const roomServer = extractServerName(roomId);
  if (roomServer && roomServer !== localServerName && event.type === "m.room.member") {
    remoteServers.add(roomServer);
  }

  if (event.type === "m.room.member") {
    const senderServer = extractServerName(event.sender);
    if (senderServer && senderServer !== localServerName) {
      remoteServers.add(senderServer);
    }

    if (event.state_key) {
      const membership =
        event.content && typeof event.content === "object" && "membership" in event.content
          ? event.content.membership
          : undefined;
      const targetServer = extractServerName(event.state_key);
      if (
        targetServer &&
        targetServer !== localServerName &&
        membership !== "invite" &&
        membership !== "knock"
      ) {
        remoteServers.add(targetServer);
      }
    }
  }

  return Array.from(remoteServers);
}

export async function fanoutEventToRemoteServers(
  db: D1Database,
  cache: KVNamespace,
  localServerName: string,
  roomId: string,
  event: PDU,
): Promise<void> {
  const members = await db
    .prepare(
      `SELECT DISTINCT user_id, membership FROM room_memberships WHERE room_id = ?`,
    )
    .bind(roomId)
    .all<MembershipServerRow>();

  const remoteServers = collectRemoteServersForEvent(
    localServerName,
    roomId,
    event,
    members.results,
  );

  if (remoteServers.length === 0) {
    return;
  }

  const txnId = `${Date.now()}-${event.event_id.substring(0, 8)}`;
  const body = { pdus: [event] };

  await Promise.all(
    remoteServers.map(async (server) => {
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
