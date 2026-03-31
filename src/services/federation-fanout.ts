import type { PDU } from "../types";
import { extractServerNameFromMatrixId } from "../utils/matrix-ids";
import { createServerAclPolicy } from "../matrix/application/features/server-acl/policy";
import {
  emitEffectWarning,
  traceEffectPromise,
  truncateDebugText,
} from "../matrix/application/effect-debug";
import { federationPut } from "./federation-keys";

type MembershipServerRow = {
  user_id: string;
  membership: string;
};

type ServerAclStateRow = {
  event_id: string;
  room_id: string;
  sender: string;
  event_type: string;
  state_key: string | null;
  content: string;
  origin_server_ts: number;
  depth: number;
  auth_events: string;
  prev_events: string;
};

function shouldOmitEventIdOverFederation(eventId: string): boolean {
  return !eventId.includes(":");
}

async function shouldFanoutEvent(
  db: D1Database,
  localServerName: string,
  roomId: string,
  event: PDU,
): Promise<boolean> {
  if (event.type === "m.room.server_acl") {
    return true;
  }

  const aclEvent = await db
    .prepare(
      `SELECT e.event_id, e.room_id, e.sender, e.event_type, e.state_key, e.content,
              e.origin_server_ts, e.depth, e.auth_events, e.prev_events
       FROM room_state rs
       JOIN events e ON rs.event_id = e.event_id
       WHERE rs.room_id = ?
         AND rs.event_type = 'm.room.server_acl'
         AND rs.state_key = ''
       LIMIT 1`,
    )
    .bind(roomId)
    .first<ServerAclStateRow>();

  if (!aclEvent) {
    return true;
  }

  const aclPolicy = createServerAclPolicy([
    {
      event_id: aclEvent.event_id,
      room_id: aclEvent.room_id,
      sender: aclEvent.sender,
      type: aclEvent.event_type,
      state_key: aclEvent.state_key ?? undefined,
      content: JSON.parse(aclEvent.content),
      origin_server_ts: aclEvent.origin_server_ts,
      depth: aclEvent.depth,
      auth_events: JSON.parse(aclEvent.auth_events),
      prev_events: JSON.parse(aclEvent.prev_events),
    },
  ]);

  return aclPolicy.allowPdu(localServerName, roomId, event).kind === "allow";
}

export function collectRemoteServersForEvent(
  localServerName: string,
  roomId: string,
  event: PDU,
  memberships: MembershipServerRow[],
): string[] {
  const remoteServers = new Set<string>();

  for (const member of memberships) {
    const server = extractServerNameFromMatrixId(member.user_id);
    if (!server || server === localServerName) {
      continue;
    }

    if (
      member.membership === "join" ||
      member.membership === "invite" ||
      member.membership === "knock"
    ) {
      remoteServers.add(server);
      continue;
    }

    if (event.type === "m.room.server_acl" && member.membership !== "leave") {
      remoteServers.add(server);
    }
  }

  const roomServer = extractServerNameFromMatrixId(roomId);
  if (roomServer && roomServer !== localServerName) {
    remoteServers.add(roomServer);
  }

  if (event.type === "m.room.member") {
    const senderServer = extractServerNameFromMatrixId(event.sender);
    if (senderServer && senderServer !== localServerName) {
      remoteServers.add(senderServer);
    }

    if (event.state_key) {
      const membership =
        event.content && typeof event.content === "object" && "membership" in event.content
          ? event.content.membership
          : undefined;
      const targetServer = extractServerNameFromMatrixId(event.state_key);
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
  if (!(await shouldFanoutEvent(db, localServerName, roomId, event))) {
    await emitEffectWarning("[federation-fanout] skipped by ACL policy", {
      roomId,
      eventId: event.event_id,
      eventType: event.type,
    });
    return;
  }

  const members = await db
    .prepare(
      `SELECT DISTINCT user_id, membership
       FROM (
         SELECT user_id, membership
         FROM room_memberships
         WHERE room_id = ?
         UNION
         SELECT rs.state_key AS user_id,
                json_extract(e.content, '$.membership') AS membership
         FROM room_state rs
         JOIN events e ON rs.event_id = e.event_id
         WHERE rs.room_id = ?
           AND rs.event_type = 'm.room.member'
           AND rs.state_key IS NOT NULL
       )`,
    )
    .bind(roomId, roomId)
    .all<MembershipServerRow>();

  const remoteServers = collectRemoteServersForEvent(
    localServerName,
    roomId,
    event,
    members.results,
  );

  await emitEffectWarning("[federation-fanout] resolved targets", {
    roomId,
    eventId: event.event_id,
    eventType: event.type,
    membershipRows: members.results.length,
    remoteServers,
    authEvents: event.auth_events?.length ?? 0,
    prevEvents: event.prev_events?.length ?? 0,
    hasHashes: Boolean(event.hashes?.sha256),
    signatureServers: Object.keys(event.signatures ?? {}),
  });

  if (remoteServers.length === 0) {
    return;
  }

  const txnId = `${Date.now()}-${event.event_id.substring(0, 8)}`;
  const payloadEvent = { ...event } as Record<string, unknown>;
  if (shouldOmitEventIdOverFederation(event.event_id)) {
    delete payloadEvent.event_id;
  }
  const body = { pdus: [payloadEvent] };

  await Promise.all(
    remoteServers.map(async (server) => {
      try {
        await traceEffectPromise(
          "[federation-fanout] send",
          {
            roomId,
            eventId: event.event_id,
            eventType: event.type,
            destination: server,
            hasHashes: Boolean(event.hashes?.sha256),
            signatureServers: Object.keys(event.signatures ?? {}),
            omitsEventId: shouldOmitEventIdOverFederation(event.event_id),
          },
          async () => {
            const response = await federationPut(
              server,
              `/_matrix/federation/v1/send/${encodeURIComponent(txnId)}`,
              body,
              localServerName,
              db,
              cache,
            );
            const responseBody = await response
              .clone()
              .text()
              .catch((error) =>
                error instanceof Error ? `<unavailable:${error.message}>` : "<unavailable>",
              );
            return {
              status: response.status,
              ok: response.ok,
              responseBody: truncateDebugText(responseBody),
            };
          },
          {
            onSuccess: (result) => result,
          },
        );
      } catch (error) {
        await emitEffectWarning("[federation-fanout] send failure", {
          roomId,
          eventId: event.event_id,
          eventType: event.type,
          destination: server,
          error,
        });
      }
    }),
  );
}
