import { getDefaultRoomVersion } from "../../services/room-versions";
import { getAuthChain, getEvent, storeEvent } from "../../services/database";
import { federationPost } from "../../services/federation-keys";
import type { MatrixSignatures, PDU } from "../../types";
import type { EventRelationshipsRequest } from "../../types/events";
import { encodeUnpaddedBase64 } from "../../utils/crypto";
import { extractServerNameFromMatrixId } from "../../utils/matrix-ids";
import { tryValidateIncomingPdu } from "./pdu-validator";
export type EventRelationshipsDirection = "up" | "down";

export type { EventRelationshipsRequest };

export interface EventRelationshipsResult {
  roomId: string;
  events: PDU[];
  limited: boolean;
  missingParentId?: string;
}

function normalizeMaxDepth(maxDepth: number | undefined): number {
  if (maxDepth === undefined || Number.isNaN(maxDepth)) {
    return 20;
  }

  return Math.max(0, Math.min(maxDepth, 50));
}

async function computeChildrenHash(eventIds: string[]): Promise<string> {
  const sorted = [...eventIds].toSorted();
  const bytes = new TextEncoder().encode(sorted.join(""));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return encodeUnpaddedBase64(new Uint8Array(hash));
}

async function buildRelationSummary(
  db: D1Database,
  eventId: string,
): Promise<Record<string, unknown> | undefined> {
  const rows = await db
    .prepare(
      `
        SELECT relation_type, event_id
        FROM event_relations
        WHERE relates_to_id = ?
      `,
    )
    .bind(eventId)
    .all<{ relation_type: string; event_id: string }>();

  if (rows.results.length === 0) {
    return undefined;
  }

  const children: Record<string, number> = {};
  const childEventIds: string[] = [];
  for (const row of rows.results) {
    children[row.relation_type] = (children[row.relation_type] ?? 0) + 1;
    childEventIds.push(row.event_id);
  }

  return {
    children,
    children_hash: await computeChildrenHash(childEventIds),
  };
}

async function augmentEvent(db: D1Database, event: PDU): Promise<PDU> {
  const unsigned = event.unsigned as Record<string, unknown> | undefined;
  if (
    unsigned &&
    typeof unsigned["children_hash"] === "string" &&
    unsigned["children"] &&
    typeof unsigned["children"] === "object" &&
    !Array.isArray(unsigned["children"])
  ) {
    return event;
  }

  const relationSummary = await buildRelationSummary(db, event.event_id);
  if (!relationSummary) {
    return event;
  }

  return {
    ...event,
    unsigned: {
      ...event.unsigned,
      ...relationSummary,
    },
  };
}

async function loadParentEventId(db: D1Database, eventId: string): Promise<string | null> {
  const row = await db
    .prepare(
      `
        SELECT relates_to_id
        FROM event_relations
        WHERE event_id = ?
        LIMIT 1
      `,
    )
    .bind(eventId)
    .first<{ relates_to_id: string }>();

  return row?.relates_to_id ?? null;
}

async function loadChildEvents(
  db: D1Database,
  roomId: string,
  eventId: string,
  recentFirst: boolean,
): Promise<PDU[]> {
  const rows = await db
    .prepare(
      `
        SELECT e.event_id, e.room_id, e.sender, e.event_type, e.state_key, e.content,
               e.origin_server_ts, e.unsigned, e.depth, e.auth_events, e.prev_events,
               e.event_origin, e.event_membership, e.prev_state, e.hashes, e.signatures
        FROM event_relations r
        INNER JOIN events e ON e.event_id = r.event_id
        WHERE r.relates_to_id = ? AND e.room_id = ?
        ORDER BY e.origin_server_ts ${recentFirst ? "DESC" : "ASC"},
                 e.stream_ordering ${recentFirst ? "DESC" : "ASC"}
      `,
    )
    .bind(eventId, roomId)
    .all<{
      event_id: string;
      room_id: string;
      sender: string;
      event_type: string;
      state_key: string | null;
      content: string;
      origin_server_ts: number;
      unsigned: string | null;
      depth: number;
      auth_events: string;
      prev_events: string;
      event_origin: string | null;
      event_membership: string | null;
      prev_state: string | null;
      hashes: string | null;
      signatures: string | null;
    }>();

  return Promise.all(
    rows.results.map((row) =>
      augmentEvent(db, {
        event_id: row.event_id,
        room_id: row.room_id,
        sender: row.sender,
        type: row.event_type,
        ...(row.state_key !== null ? { state_key: row.state_key } : {}),
        content: JSON.parse(row.content) as Record<string, unknown>,
        origin_server_ts: row.origin_server_ts,
        depth: row.depth,
        auth_events: JSON.parse(row.auth_events) as string[],
        prev_events: JSON.parse(row.prev_events) as string[],
        ...(row.unsigned ? { unsigned: JSON.parse(row.unsigned) as Record<string, unknown> } : {}),
        ...(row.event_origin ? { origin: row.event_origin } : {}),
        ...(row.event_membership ? { membership: row.event_membership as PDU["membership"] } : {}),
        ...(row.prev_state ? { prev_state: JSON.parse(row.prev_state) as string[] } : {}),
        ...(row.hashes ? { hashes: JSON.parse(row.hashes) as { sha256: string } } : {}),
        ...(row.signatures ? { signatures: JSON.parse(row.signatures) as MatrixSignatures } : {}),
      }),
    ),
  );
}

async function resolveRoomId(
  db: D1Database,
  eventId: string,
  explicitRoomId?: string,
): Promise<string | null> {
  if (explicitRoomId) {
    return explicitRoomId;
  }

  const event = await getEvent(db, eventId);
  return event?.room_id ?? null;
}

export async function getRemoteServersForRoom(
  db: D1Database,
  roomId: string,
  localServerName: string,
): Promise<string[]> {
  const rows = await db
    .prepare(
      `
        WITH memberships AS (
          SELECT user_id
          FROM room_memberships
          WHERE room_id = ? AND membership IN ('join', 'invite', 'knock')
          UNION
          SELECT rs.state_key AS user_id
          FROM room_state rs
          INNER JOIN events e ON e.event_id = rs.event_id
          WHERE rs.room_id = ?
            AND rs.event_type = 'm.room.member'
            AND json_extract(e.content, '$.membership') IN ('join', 'invite', 'knock')
        )
        SELECT DISTINCT user_id FROM memberships
      `,
    )
    .bind(roomId, roomId)
    .all<{ user_id: string }>();

  return Array.from(
    new Set(
      rows.results
        .map((row) => extractServerNameFromMatrixId(row.user_id))
        .filter(
          (serverName): serverName is string => !!serverName && serverName !== localServerName,
        ),
    ),
  ).toSorted();
}

export async function persistFederatedRelationshipResponse(
  db: D1Database,
  roomVersion: string,
  response: {
    events?: unknown[];
    auth_chain?: unknown[];
  },
): Promise<void> {
  const authChain = Array.isArray(response.auth_chain) ? response.auth_chain : [];
  const events = Array.isArray(response.events) ? response.events : [];

  for (const rawEvent of authChain) {
    const event = await tryValidateIncomingPdu(rawEvent, "auth_chain", roomVersion);
    if (event) {
      await storeEvent(db, event);
    }
  }

  for (const rawEvent of events) {
    const event = await tryValidateIncomingPdu(rawEvent, "event_relationships", roomVersion);
    if (event) {
      await storeEvent(db, event);
    }
  }
}

export async function fetchFederatedEventRelationships(
  db: D1Database,
  cache: KVNamespace,
  localServerName: string,
  roomVersion: string,
  remoteServerName: string,
  request: EventRelationshipsRequest,
): Promise<boolean> {
  const response = await federationPost(
    remoteServerName,
    "/_matrix/federation/unstable/event_relationships",
    {
      event_id: request.eventId,
      ...(request.roomId ? { room_id: request.roomId } : {}),
      direction: request.direction,
      ...(request.includeParent !== undefined ? { include_parent: request.includeParent } : {}),
      ...(request.recentFirst !== undefined ? { recent_first: request.recentFirst } : {}),
      ...(request.maxDepth !== undefined ? { max_depth: request.maxDepth } : {}),
    },
    localServerName,
    db,
    cache,
  );

  if (!response.ok) {
    return false;
  }

  const payload = (await response.json()) as {
    events?: unknown[];
    auth_chain?: unknown[];
  };
  await persistFederatedRelationshipResponse(db, roomVersion, payload);
  return true;
}

export async function queryEventRelationships(
  db: D1Database,
  request: EventRelationshipsRequest,
): Promise<EventRelationshipsResult | null> {
  const roomId = await resolveRoomId(db, request.eventId, request.roomId);
  if (!roomId) {
    return null;
  }

  const root = await getEvent(db, request.eventId);
  if (!root || root.room_id !== roomId) {
    return null;
  }

  const maxDepth = normalizeMaxDepth(request.maxDepth);
  const recentFirst = request.recentFirst ?? true;
  const seen = new Set<string>();
  const events: PDU[] = [];

  const addEvent = async (event: PDU | null): Promise<void> => {
    if (!event || seen.has(event.event_id)) {
      return;
    }
    seen.add(event.event_id);
    events.push(await augmentEvent(db, event));
  };

  await addEvent(root);

  if (request.direction === "up") {
    let current = root;
    let remainingDepth = maxDepth;
    while (remainingDepth > 0) {
      const parentId = await loadParentEventId(db, current.event_id);
      if (!parentId) {
        break;
      }

      const parent = await getEvent(db, parentId);
      if (!parent) {
        return {
          roomId,
          events,
          limited: false,
          missingParentId: parentId,
        };
      }

      await addEvent(parent);
      current = parent;
      remainingDepth -= 1;
    }

    return { roomId, events, limited: false };
  }

  if (request.includeParent) {
    const parentId = await loadParentEventId(db, root.event_id);
    if (parentId) {
      await addEvent(await getEvent(db, parentId));
    }
  }

  const queue: Array<{ eventId: string; depth: number }> = [{ eventId: root.event_id, depth: 0 }];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth >= maxDepth) {
      continue;
    }

    const children = await loadChildEvents(db, roomId, current.eventId, recentFirst);
    for (const child of children) {
      if (seen.has(child.event_id)) {
        continue;
      }

      seen.add(child.event_id);
      events.push(child);
      queue.push({ eventId: child.event_id, depth: current.depth + 1 });
    }
  }

  return { roomId, events, limited: false };
}

export async function buildFederatedEventRelationshipsResponse(
  db: D1Database,
  request: EventRelationshipsRequest,
): Promise<{ events: PDU[]; limited: boolean; auth_chain: PDU[] } | null> {
  const result = await queryEventRelationships(db, request);
  if (!result) {
    return null;
  }

  const authEventIds = Array.from(new Set(result.events.flatMap((event) => event.auth_events)));
  return {
    events: result.events,
    limited: result.limited,
    auth_chain: await getAuthChain(db, authEventIds),
  };
}

export async function getRoomVersionForRelationships(
  db: D1Database,
  roomId: string,
): Promise<string> {
  const row = await db
    .prepare(`SELECT room_version FROM rooms WHERE room_id = ?`)
    .bind(roomId)
    .first<{ room_version: string }>();

  return row?.room_version ?? getDefaultRoomVersion();
}
