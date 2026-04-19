import { sql, type RawBuilder } from "kysely";
import {
  createKyselyBuilder,
  executeKyselyQuery,
  executeKyselyQueryFirst,
  executeKyselyRun,
  type CompiledQuery,
} from "../../infra/db/kysely";
import type {
  EventId,
  MatrixSignatures,
  Membership,
  PDU,
  RoomId,
  UserId,
} from "../../shared/types";
import { toEventId, toRoomId, toUserId } from "../../shared/utils/ids";
import { extractServerNameFromMatrixId } from "../../shared/utils/matrix-ids";

type StoredEventRow = {
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
  hashes: string | null;
  signatures: string | null;
  unsigned?: string | null;
};

type RoomStatePointerRow = {
  state_key: string;
  event_id: string;
};

type InviteStrippedStateRecord = {
  type: string;
  state_key: string;
  content: Record<string, unknown>;
  sender: string;
};

type FederationStateBundle = {
  state: PDU[];
  authChain: PDU[];
  roomState: PDU[];
  serversInRoom: string[];
};

interface FederationStateDatabase {
  events: {
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
    hashes: string | null;
    signatures: string | null;
    unsigned: string | null;
    stream_ordering: number;
  };
  event_relations: {
    event_id: string;
    relates_to_id: string;
    relation_type: string;
    aggregation_key: string | null;
  };
  room_state: {
    room_id: string;
    event_type: string;
    state_key: string;
    event_id: string;
  };
  rooms: {
    room_id: string;
    room_version: string;
    creator_id: string;
    is_public: number;
  };
  invite_stripped_state: {
    room_id: string;
    event_type: string;
    state_key: string;
    content: string;
    sender: string;
  };
  room_memberships: {
    room_id: string;
    user_id: string;
    membership: string;
    event_id: string;
    display_name: string | null;
    avatar_url: string | null;
  };
  processed_pdus: {
    event_id: string;
    accepted: number;
    rejection_reason: string | null;
  };
}

const qb = createKyselyBuilder<FederationStateDatabase>();

function asCompiledQuery<T>(query: RawBuilder<T>): CompiledQuery {
  return {
    compile: () => query.compile(qb),
  };
}

function parseJson<T>(value: string | null | undefined, fallback?: T): T | undefined {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function rowToPdu(row: StoredEventRow): PDU {
  const eventId = toEventId(row.event_id);
  const roomId = toRoomId(row.room_id);
  const sender = toUserId(row.sender);
  if (!eventId || !roomId || !sender) {
    throw new TypeError("Stored event row contains invalid Matrix identifiers");
  }

  return {
    event_id: eventId,
    room_id: roomId,
    sender,
    type: row.event_type,
    state_key: row.state_key ?? undefined,
    content: parseJson<Record<string, unknown>>(row.content, {}) ?? {},
    origin_server_ts: row.origin_server_ts,
    depth: row.depth,
    auth_events: (parseJson<string[]>(row.auth_events, []) ?? []).flatMap((id) => {
      const typedId = toEventId(id);
      return typedId ? [typedId] : [];
    }),
    prev_events: (parseJson<string[]>(row.prev_events, []) ?? []).flatMap((id) => {
      const typedId = toEventId(id);
      return typedId ? [typedId] : [];
    }),
    unsigned: parseJson<Record<string, unknown> | undefined>(row.unsigned),
    hashes: parseJson<{ sha256: string } | undefined>(row.hashes),
    signatures: parseJson<MatrixSignatures | undefined>(row.signatures),
  };
}

type ExtractedRelation = {
  relatesToId: string;
  relationType: string;
  aggregationKey: string | null;
};

function extractEventRelation(event: PDU): ExtractedRelation | null {
  const rawRelation = event.content["m.relates_to"] ?? event.content["m.relationship"];
  if (!rawRelation || typeof rawRelation !== "object" || Array.isArray(rawRelation)) {
    return null;
  }

  const relationRecord = rawRelation as Record<string, unknown>;
  const relationType =
    typeof relationRecord["rel_type"] === "string" ? relationRecord["rel_type"] : undefined;
  const relatesToId =
    typeof relationRecord["event_id"] === "string" ? relationRecord["event_id"] : undefined;
  const aggregationKey = typeof relationRecord["key"] === "string" ? relationRecord["key"] : null;
  return relationType && relatesToId ? { relatesToId, relationType, aggregationKey } : null;
}

async function persistFederationEventRelation(db: D1Database, event: PDU): Promise<void> {
  const relation = extractEventRelation(event);
  if (!relation) {
    return;
  }

  await executeKyselyRun(
    db,
    asCompiledQuery(sql`
      INSERT OR REPLACE INTO event_relations
        (event_id, relates_to_id, relation_type, aggregation_key)
      VALUES (${event.event_id}, ${relation.relatesToId}, ${relation.relationType}, ${relation.aggregationKey})
    `),
  );
}

export async function storeFederationEvent(
  db: D1Database,
  event: PDU,
  options?: { skipRoomState?: boolean },
): Promise<number> {
  const skipRoomState = options?.skipRoomState ?? false;
  const existing = await executeKyselyQueryFirst<{ stream_ordering: number }>(
    db,
    asCompiledQuery(sql<{ stream_ordering: number }>`
      SELECT stream_ordering FROM events WHERE event_id = ${event.event_id}
    `),
  );

  if (existing) {
    await persistFederationEventRelation(db, event);
    if (!skipRoomState && event.state_key !== undefined) {
      await upsertFederatedRoomState(
        db,
        event.room_id,
        event.type,
        event.state_key,
        event.event_id,
      );
    }
    return existing.stream_ordering;
  }

  const lastOrdering = await executeKyselyQueryFirst<{ max_ordering: number | null }>(
    db,
    asCompiledQuery(sql<{ max_ordering: number | null }>`
      SELECT MAX(stream_ordering) AS max_ordering FROM events
    `),
  );
  const streamOrdering = (lastOrdering?.max_ordering ?? 0) + 1;

  await executeKyselyRun(
    db,
    asCompiledQuery(sql`
      INSERT OR IGNORE INTO events (
        event_id, room_id, sender, event_type, state_key, content,
        origin_server_ts, unsigned, depth, auth_events, prev_events, event_origin,
        event_membership, prev_state, hashes, signatures, stream_ordering
      )
      VALUES (
        ${event.event_id},
        ${event.room_id},
        ${event.sender},
        ${event.type},
        ${event.state_key ?? null},
        ${JSON.stringify(event.content)},
        ${event.origin_server_ts},
        ${event.unsigned ? JSON.stringify(event.unsigned) : null},
        ${event.depth},
        ${JSON.stringify(event.auth_events)},
        ${JSON.stringify(event.prev_events)},
        ${event.origin ?? null},
        ${event.membership ?? null},
        ${event.prev_state ? JSON.stringify(event.prev_state) : null},
        ${event.hashes ? JSON.stringify(event.hashes) : null},
        ${event.signatures ? JSON.stringify(event.signatures) : null},
        ${streamOrdering}
      )
    `),
  );

  await persistFederationEventRelation(db, event);
  if (!skipRoomState && event.state_key !== undefined) {
    await upsertFederatedRoomState(db, event.room_id, event.type, event.state_key, event.event_id);
  }

  return streamOrdering;
}

export async function getFederationStoredEvent(
  db: D1Database,
  eventId: EventId,
): Promise<PDU | null> {
  const row = await executeKyselyQueryFirst<StoredEventRow>(
    db,
    asCompiledQuery(sql<StoredEventRow>`
      SELECT event_id, room_id, sender, event_type, state_key, content,
             origin_server_ts, depth, auth_events, prev_events, hashes, signatures, unsigned
      FROM events
      WHERE event_id = ${eventId}
    `),
  );

  return row ? rowToPdu(row) : null;
}

export async function getFederationRoomState(db: D1Database, roomId: RoomId): Promise<PDU[]> {
  const rows = await executeKyselyQuery<StoredEventRow>(
    db,
    asCompiledQuery(sql<StoredEventRow>`
      SELECT e.event_id, e.room_id, e.sender, e.event_type, e.state_key, e.content,
             e.origin_server_ts, e.depth, e.auth_events, e.prev_events, e.hashes, e.signatures, e.unsigned
      FROM room_state rs
      JOIN events e ON rs.event_id = e.event_id
      WHERE rs.room_id = ${roomId}
    `),
  );

  const events = rows.map(rowToPdu);
  if (!events.some((event) => event.type === "m.room.create")) {
    const createEvent = await loadCreateEventFallbackFromRepository(db, roomId);
    if (createEvent) {
      events.push(createEvent);
    }
  }

  return events;
}

const DEFERRED_AUTH_MARKER_SEARCH_PATTERN = `%"io.tuwunel.partial_state_auth_deferred"%`;

export function getDeferredFederationAuthEvents(db: D1Database, roomId: RoomId): Promise<PDU[]> {
  return executeKyselyQuery<StoredEventRow>(
    db,
    asCompiledQuery(sql<StoredEventRow>`
      SELECT event_id, room_id, sender, event_type, state_key, content,
             origin_server_ts, depth, auth_events, prev_events, hashes, signatures, unsigned
      FROM events
      WHERE room_id = ${roomId} AND unsigned LIKE ${DEFERRED_AUTH_MARKER_SEARCH_PATTERN}
    `),
  ).then((rows) => rows.map(rowToPdu));
}

export async function clearDeferredFederationAuthMarker(
  db: D1Database,
  eventId: EventId,
): Promise<void> {
  const row = await executeKyselyQueryFirst<{ unsigned: string | null }>(
    db,
    asCompiledQuery(sql<{ unsigned: string | null }>`
      SELECT unsigned FROM events WHERE event_id = ${eventId}
    `),
  );
  if (!row?.unsigned) {
    return;
  }

  const unsigned = parseJson<Record<string, unknown>>(row.unsigned, {});
  if (!unsigned) {
    return;
  }

  delete unsigned["io.tuwunel.partial_state_auth_deferred"];
  delete unsigned["io.tuwunel.partial_state_auth_deferred_previous_event_id"];
  delete unsigned["io.tuwunel.partial_state_auth_deferred_previous_membership"];

  await executeKyselyRun(
    db,
    asCompiledQuery(sql`
      UPDATE events
      SET unsigned = ${Object.keys(unsigned).length > 0 ? JSON.stringify(unsigned) : null}
      WHERE event_id = ${eventId}
    `),
  );
}

export function rejectDeferredFederationAuthEvent(
  db: D1Database,
  eventId: EventId,
  reason: string,
): Promise<void> {
  return executeKyselyRun(
    db,
    asCompiledQuery(sql`
      UPDATE processed_pdus
      SET accepted = 0, rejection_reason = ${reason}
      WHERE event_id = ${eventId}
    `),
  );
}

export function deleteFederatedRoomState(
  db: D1Database,
  roomId: RoomId,
  eventType: string,
  stateKey: string,
): Promise<void> {
  return executeKyselyRun(
    db,
    asCompiledQuery(sql`
      DELETE FROM room_state
      WHERE room_id = ${roomId} AND event_type = ${eventType} AND state_key = ${stateKey}
    `),
  );
}

export async function restoreFederationMembershipState(
  db: D1Database,
  input: {
    roomId: RoomId;
    userId: UserId;
    membership: Membership;
    event: PDU;
  },
): Promise<void> {
  await upsertFederatedRoomState(
    db,
    input.roomId,
    input.event.type,
    input.userId,
    input.event.event_id,
  );

  const memberContent = input.event.content as { displayname?: string; avatar_url?: string };
  await executeKyselyRun(
    db,
    asCompiledQuery(sql`
      INSERT OR REPLACE INTO room_memberships
        (room_id, user_id, membership, event_id, display_name, avatar_url)
      VALUES (
        ${input.roomId},
        ${input.userId},
        ${input.membership},
        ${input.event.event_id},
        ${memberContent.displayname ?? null},
        ${memberContent.avatar_url ?? null}
      )
    `),
  );

  if (input.membership !== "invite") {
    const remainingInvites = await executeKyselyQueryFirst<{ count: number | string }>(
      db,
      asCompiledQuery(sql<{ count: number | string }>`
        SELECT COUNT(*) AS count
        FROM room_memberships
        WHERE room_id = ${input.roomId} AND membership = 'invite'
      `),
    );
    if (Number(remainingInvites?.count ?? 0) === 0) {
      await executeKyselyRun(
        db,
        asCompiledQuery(sql`
          DELETE FROM invite_stripped_state
          WHERE room_id = ${input.roomId}
        `),
      );
    }
  }
}

export async function loadCreateEventFallbackFromRepository(
  db: D1Database,
  roomId: string,
): Promise<PDU | null> {
  const createRow = await executeKyselyQueryFirst<StoredEventRow>(
    db,
    asCompiledQuery(sql<StoredEventRow>`
      SELECT event_id, room_id, sender, event_type, state_key, content, origin_server_ts, depth,
             auth_events, prev_events, hashes, signatures, unsigned
      FROM events
      WHERE room_id = ${roomId} AND event_type = 'm.room.create'
      LIMIT 1
    `),
  );

  return createRow ? rowToPdu(createRow) : null;
}

async function getFederationAuthChain(db: D1Database, eventIds: string[]): Promise<PDU[]> {
  const seen = new Set<string>();
  const chain: PDU[] = [];
  const queue = [...eventIds];

  while (queue.length > 0) {
    const batch = queue.splice(0, 50).filter((eventId) => !seen.has(eventId));
    if (batch.length === 0) {
      continue;
    }
    for (const eventId of batch) {
      seen.add(eventId);
    }

    const rows = await executeKyselyQuery<StoredEventRow>(
      db,
      asCompiledQuery(sql<StoredEventRow>`
        SELECT event_id, room_id, sender, event_type, state_key, content,
               origin_server_ts, depth, auth_events, prev_events, hashes, signatures, unsigned
        FROM events
        WHERE event_id IN (${sql.join(batch)})
      `),
    );

    for (const row of rows) {
      const event = rowToPdu(row);
      chain.push(event);
      for (const authEventId of event.auth_events) {
        if (!seen.has(authEventId)) {
          queue.push(authEventId);
        }
      }
    }
  }

  return chain;
}

export async function loadFederationStateBundleFromRepository(
  db: D1Database,
  roomId: string,
): Promise<FederationStateBundle> {
  const stateRows = await executeKyselyQuery<StoredEventRow>(
    db,
    asCompiledQuery(sql<StoredEventRow>`
      SELECT e.event_id, e.room_id, e.sender, e.event_type, e.state_key, e.content,
             e.origin_server_ts, e.depth, e.auth_events, e.prev_events, e.hashes, e.signatures, e.unsigned
      FROM room_state rs
      JOIN events e ON rs.event_id = e.event_id
      WHERE rs.room_id = ${roomId}
    `),
  );

  const state = stateRows.map(rowToPdu);
  const roomState = [...state];
  if (!roomState.some((event) => event.type === "m.room.create")) {
    const createEvent = await loadCreateEventFallbackFromRepository(db, roomId);
    if (createEvent) {
      roomState.push(createEvent);
    }
  }

  const authChainIds = new Set<string>();
  for (const event of roomState) {
    for (const authEventId of event.auth_events) {
      authChainIds.add(authEventId);
    }
  }

  const authChain = await getFederationAuthChain(db, Array.from(authChainIds));
  const serversInRoom = Array.from(
    new Set(
      roomState
        .filter((event) => event.type === "m.room.member" && event.content.membership === "join")
        .map((event) => extractServerNameFromMatrixId(event.sender))
        .filter((server): server is string => Boolean(server)),
    ),
  );

  return { state: roomState, authChain, roomState, serversInRoom };
}

export async function federationEventExists(db: D1Database, eventId: string): Promise<boolean> {
  const row = await executeKyselyQueryFirst<{ event_id: string }>(
    db,
    asCompiledQuery(sql<{ event_id: string }>`
      SELECT event_id FROM events WHERE event_id = ${eventId}
    `),
  );

  return row !== null;
}

export function listFederationMembershipStatePointers(
  db: D1Database,
  roomId: string,
): Promise<RoomStatePointerRow[]> {
  return executeKyselyQuery<RoomStatePointerRow>(
    db,
    asCompiledQuery(sql<RoomStatePointerRow>`
      SELECT state_key, event_id
      FROM room_state
      WHERE room_id = ${roomId} AND event_type = 'm.room.member'
    `),
  );
}

export async function getFederationRoomVersion(db: D1Database, roomId: string): Promise<string> {
  const roomRow = await executeKyselyQueryFirst<{ room_version: string }>(
    db,
    asCompiledQuery(sql<{ room_version: string }>`
      SELECT room_version FROM rooms WHERE room_id = ${roomId}
    `),
  );

  return roomRow?.room_version ?? "10";
}

export async function persistInviteStrippedStateRecords(
  db: D1Database,
  roomId: string,
  strippedStateEvents: unknown[],
): Promise<void> {
  const records = strippedStateEvents.flatMap((event): InviteStrippedStateRecord[] => {
    if (!event || typeof event !== "object") {
      return [];
    }

    const record = event as Record<string, unknown>;
    if (typeof record.type !== "string" || typeof record.sender !== "string") {
      return [];
    }

    return [
      {
        type: record.type,
        state_key: typeof record.state_key === "string" ? record.state_key : "",
        content:
          record.content && typeof record.content === "object"
            ? (record.content as Record<string, unknown>)
            : {},
        sender: record.sender,
      },
    ];
  });

  for (const record of records) {
    await executeKyselyRun(
      db,
      asCompiledQuery(sql`
        INSERT OR REPLACE INTO invite_stripped_state (room_id, event_type, state_key, content, sender)
        VALUES (
          ${roomId},
          ${record.type},
          ${record.state_key},
          ${JSON.stringify(record.content)},
          ${record.sender}
        )
      `),
    );
  }
}

export function ensureFederatedRoomStubRecord(
  db: D1Database,
  roomId: string,
  roomVersion: string,
  creatorId: string,
): Promise<void> {
  return executeKyselyRun(
    db,
    asCompiledQuery(sql`
      INSERT OR IGNORE INTO rooms (room_id, room_version, creator_id, is_public)
      VALUES (${roomId}, ${roomVersion}, ${creatorId}, 0)
    `),
  );
}

export function upsertFederatedRoomState(
  db: D1Database,
  roomId: string,
  eventType: string,
  stateKey: string,
  eventId: string,
): Promise<void> {
  return executeKyselyRun(
    db,
    asCompiledQuery(sql`
      INSERT OR REPLACE INTO room_state (room_id, event_type, state_key, event_id)
      VALUES (${roomId}, ${eventType}, ${stateKey}, ${eventId})
    `),
  );
}

export async function getEffectiveMembershipForRealtimeUser(
  db: D1Database,
  roomId: string,
  userId: string,
): Promise<string | null> {
  const membership = await executeKyselyQueryFirst<{ membership: string }>(
    db,
    asCompiledQuery(
      sql<{
        membership: string;
      }>`SELECT membership FROM room_memberships WHERE room_id = ${roomId} AND user_id = ${userId} LIMIT 1`,
    ),
  );

  if (membership?.membership) {
    return membership.membership;
  }

  const stateMembership = await executeKyselyQueryFirst<{ membership: string | null }>(
    db,
    asCompiledQuery(
      sql<{
        membership: string | null;
      }>`SELECT json_extract(e.content, '$.membership') AS membership FROM room_state rs JOIN events e ON rs.event_id = e.event_id WHERE rs.room_id = ${roomId} AND rs.event_type = 'm.room.member' AND rs.state_key = ${userId} LIMIT 1`,
    ),
  );

  return stateMembership?.membership ?? null;
}
