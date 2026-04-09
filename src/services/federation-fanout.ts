import { Effect } from "effect";
import type { EventId, PDU } from "../types";
import { extractServerNameFromMatrixId } from "../utils/matrix-ids";
import { toEventId, toRoomId, toUserId } from "../utils/ids";
import { createServerAclPolicy } from "../matrix/application/features/server-acl/policy";
import { emitEffectWarningEffect } from "../matrix/application/effect-debug";
import type { FederationOutboundPort } from "./federation-outbound";

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

export interface FederationFanoutPorts {
  now(): number;
  runEffect<A, E>(effect: Effect.Effect<A, E>): Promise<A>;
  enqueuePdu(input: {
    destination: string;
    eventId: string;
    roomId: string;
    pdu: Record<string, unknown>;
  }): Promise<void>;
}

export function createFederationFanoutPorts(
  outbound: Pick<FederationOutboundPort, "enqueuePdu">,
): FederationFanoutPorts {
  return {
    now: () => Date.now(),
    runEffect: Effect.runPromise,
    enqueuePdu: outbound.enqueuePdu,
  };
}

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
      event_id: toEventId(aclEvent.event_id) ?? event.event_id,
      room_id: toRoomId(aclEvent.room_id) ?? toRoomId(roomId) ?? event.room_id,
      sender: toUserId(aclEvent.sender) ?? event.sender,
      type: aclEvent.event_type,
      state_key: aclEvent.state_key ?? undefined,
      content: JSON.parse(aclEvent.content),
      origin_server_ts: aclEvent.origin_server_ts,
      depth: aclEvent.depth,
      auth_events: (JSON.parse(aclEvent.auth_events) as string[])
        .map((value) => toEventId(value))
        .filter((value): value is EventId => value !== null),
      prev_events: (JSON.parse(aclEvent.prev_events) as string[])
        .map((value) => toEventId(value))
        .filter((value): value is EventId => value !== null),
    },
  ]);

  return aclPolicy.allowPdu(localServerName, roomId, event).kind === "allow";
}

export function collectRemoteServersForEvent(
  localServerName: string,
  roomId: string,
  event: PDU,
  memberships: MembershipServerRow[],
  excludeServers: string[] = [],
): string[] {
  const remoteServers = new Set<string>();
  const excluded = new Set(
    [...excludeServers, ...Object.keys(event.signatures ?? {})].filter(
      (server) => server !== localServerName,
    ),
  );

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

  return Array.from(remoteServers).filter((server) => !excluded.has(server));
}

export async function fanoutEventToRemoteServersWithPorts(
  ports: FederationFanoutPorts,
  db: D1Database,
  localServerName: string,
  roomId: string,
  event: PDU,
  excludeServers: string[] = [],
): Promise<void> {
  if (!(await shouldFanoutEvent(db, localServerName, roomId, event))) {
    await ports.runEffect(
      emitEffectWarningEffect("[federation-fanout] skipped by ACL policy", {
        roomId,
        eventId: event.event_id,
        eventType: event.type,
      }),
    );
    return;
  }

  const members = await db
    .prepare(
      `WITH current_memberships AS (
         SELECT room_id, user_id, membership
         FROM room_memberships
         WHERE room_id = ?

         UNION

         SELECT
           rs.room_id,
           rs.state_key AS user_id,
           json_extract(e.content, '$.membership') AS membership
         FROM room_state rs
         JOIN events e ON rs.event_id = e.event_id
         WHERE rs.room_id = ?
           AND rs.event_type = 'm.room.member'
           AND rs.state_key IS NOT NULL
           AND NOT EXISTS (
             SELECT 1
             FROM room_memberships rm
             WHERE rm.room_id = rs.room_id
               AND rm.user_id = rs.state_key
           )
       )
       SELECT DISTINCT user_id, membership
       FROM current_memberships`,
    )
    .bind(roomId, roomId)
    .all<MembershipServerRow>();

  const remoteServers = collectRemoteServersForEvent(
    localServerName,
    roomId,
    event,
    members.results,
    excludeServers,
  );

  await ports.runEffect(
    emitEffectWarningEffect("[federation-fanout] resolved targets", {
      roomId,
      eventId: event.event_id,
      eventType: event.type,
      membershipRows: members.results.length,
      remoteServers,
      authEvents: event.auth_events?.length ?? 0,
      prevEvents: event.prev_events?.length ?? 0,
      hasHashes: Boolean(event.hashes?.sha256),
      signatureServers: Object.keys(event.signatures ?? {}),
    }),
  );

  if (remoteServers.length === 0) {
    return;
  }

  const payloadEvent = { ...event } as Record<string, unknown>;
  if (shouldOmitEventIdOverFederation(event.event_id)) {
    delete payloadEvent.event_id;
  }

  await Promise.all(
    remoteServers.map(async (server) => {
      try {
        await ports.enqueuePdu({
          destination: server,
          eventId: event.event_id,
          roomId,
          pdu: payloadEvent,
        });
        await ports.runEffect(
          emitEffectWarningEffect("[federation-fanout] enqueued", {
            roomId,
            eventId: event.event_id,
            eventType: event.type,
            destination: server,
            hasHashes: Boolean(event.hashes?.sha256),
            signatureServers: Object.keys(event.signatures ?? {}),
            omitsEventId: shouldOmitEventIdOverFederation(event.event_id),
            queuedAt: ports.now(),
          }),
        );
      } catch (error) {
        await ports.runEffect(
          emitEffectWarningEffect("[federation-fanout] send failure", {
            roomId,
            eventId: event.event_id,
            eventType: event.type,
            destination: server,
            error,
          }),
        );
      }
    }),
  );
}

export async function fanoutEventToRemoteServers(
  outbound: Pick<FederationOutboundPort, "enqueuePdu">,
  db: D1Database,
  localServerName: string,
  roomId: string,
  event: PDU,
  excludeServers: string[] = [],
): Promise<void> {
  await fanoutEventToRemoteServersWithPorts(
    createFederationFanoutPorts(outbound),
    db,
    localServerName,
    roomId,
    event,
    excludeServers,
  );
}
