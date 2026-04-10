import { sql, type RawBuilder } from "kysely";
import {
  createKyselyBuilder,
  executeKyselyQuery,
  executeKyselyQueryFirst,
  type CompiledQuery,
} from "../../infra/db/kysely";
import type { MatrixSignatures, PDU, StoredPduRow } from "../../shared/types";
import { toEventId } from "../../shared/utils/ids";

interface EventRow {
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
  event_origin: string | null;
  event_membership: string | null;
  prev_state: string | null;
  hashes: string | null;
  signatures: string | null;
}

interface RoomRow {
  room_id: string;
  room_version: string;
}

interface FederationEventsDatabase {
  events: EventRow;
  rooms: RoomRow;
}

const qb = createKyselyBuilder<FederationEventsDatabase>();

function asCompiledQuery<T>(query: RawBuilder<T>): CompiledQuery {
  return {
    compile: () => query.compile(qb),
  };
}

function parseJsonWithFallback<T>(value: string | null | undefined, fallback: T): T {
  if (!value) {
    return fallback;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function getEventReferenceLookupCandidates(eventId: string): string[] {
  const normalized = eventId.replaceAll("+", "-").replaceAll("/", "_");
  const standard = eventId.replaceAll("-", "+").replaceAll("_", "/");
  return Array.from(new Set([eventId, normalized, standard]));
}

export function toFederationPduFromRow(row: StoredPduRow): PDU {
  return {
    event_id: row.event_id,
    room_id: row.room_id,
    sender: row.sender,
    type: row.event_type,
    ...(row.state_key !== null ? { state_key: row.state_key } : {}),
    ...(row.event_origin ? { origin: row.event_origin } : {}),
    ...(row.event_membership ? { membership: row.event_membership } : {}),
    ...(row.prev_state
      ? {
          prev_state: parseJsonWithFallback<string[]>(row.prev_state, []).flatMap((id) => {
            const typedId = toEventId(id);
            return typedId ? [typedId] : [];
          }),
        }
      : {}),
    content: parseJsonWithFallback<Record<string, unknown>>(row.content, {}),
    origin_server_ts: row.origin_server_ts,
    depth: row.depth,
    auth_events: parseJsonWithFallback<string[]>(row.auth_events, []).flatMap((id) => {
      const typedId = toEventId(id);
      return typedId ? [typedId] : [];
    }),
    prev_events: parseJsonWithFallback<string[]>(row.prev_events, []).flatMap((id) => {
      const typedId = toEventId(id);
      return typedId ? [typedId] : [];
    }),
    ...(row.hashes ? { hashes: parseJsonWithFallback(row.hashes, { sha256: "" }) } : {}),
    ...(row.signatures
      ? { signatures: parseJsonWithFallback<MatrixSignatures>(row.signatures, {}) }
      : {}),
  };
}

export function getFederationEventRowById(
  db: D1Database,
  eventId: string,
): Promise<StoredPduRow | null> {
  return executeKyselyQueryFirst<StoredPduRow>(
    db,
    asCompiledQuery(sql<StoredPduRow>`
      SELECT event_id, room_id, sender, event_type, state_key, content,
             origin_server_ts, depth, auth_events, prev_events, event_origin,
             event_membership, prev_state, hashes, signatures
      FROM events
      WHERE event_id = ${eventId}
    `),
  );
}

export async function getFederationEventRowByReference(
  db: D1Database,
  eventId: string,
): Promise<StoredPduRow | null> {
  for (const candidate of getEventReferenceLookupCandidates(eventId)) {
    const row = await getFederationEventRowById(db, candidate);
    if (row) {
      return row;
    }
  }
  return null;
}

export async function getFederationRoomRecord(
  db: D1Database,
  roomId: string,
): Promise<{ roomId: string; roomVersion: string } | null> {
  const row = await executeKyselyQueryFirst<RoomRow>(
    db,
    qb.selectFrom("rooms").select(["room_id", "room_version"]).where("room_id", "=", roomId),
  );
  return row ? { roomId: row.room_id, roomVersion: row.room_version } : null;
}

export function listFederationStateEventRows(
  db: D1Database,
  roomId: string,
): Promise<StoredPduRow[]> {
  return executeKyselyQuery<StoredPduRow>(
    db,
    asCompiledQuery(sql<StoredPduRow>`
      SELECT e.event_id, e.room_id, e.sender, e.event_type, e.state_key, e.content,
             e.origin_server_ts, e.depth, e.auth_events, e.prev_events, e.event_origin,
             e.event_membership, e.prev_state, e.hashes, e.signatures
      FROM room_state rs
      JOIN events e ON rs.event_id = e.event_id
      WHERE rs.room_id = ${roomId}
    `),
  );
}

export function listFederationStateEventIdRows(
  db: D1Database,
  roomId: string,
): Promise<Array<{ event_id: string; auth_events: string }>> {
  return executeKyselyQuery<{ event_id: string; auth_events: string }>(
    db,
    asCompiledQuery(sql<{ event_id: string; auth_events: string }>`
      SELECT e.event_id, e.auth_events
      FROM room_state rs
      JOIN events e ON rs.event_id = e.event_id
      WHERE rs.room_id = ${roomId}
    `),
  );
}

export function getFederationEventAuthSeed(
  db: D1Database,
  roomId: string,
  eventId: string,
): Promise<{ event_id: string; auth_events: string } | null> {
  return executeKyselyQueryFirst<{ event_id: string; auth_events: string }>(
    db,
    asCompiledQuery(sql<{ event_id: string; auth_events: string }>`
      SELECT event_id, auth_events
      FROM events
      WHERE event_id = ${eventId} AND room_id = ${roomId}
    `),
  );
}

export function getMinimumDepthForEvents(
  db: D1Database,
  eventIds: readonly string[],
): Promise<number | null> {
  if (eventIds.length === 0) {
    return Promise.resolve(null);
  }
  return executeKyselyQueryFirst<{ min_depth: number | null }>(
    db,
    asCompiledQuery(sql<{ min_depth: number | null }>`
      SELECT MIN(depth) AS min_depth
      FROM events
      WHERE event_id IN (${sql.join(
        eventIds.map((eventId) => sql`${eventId}`),
        sql`, `,
      )})
    `),
  ).then((row) => row?.min_depth ?? null);
}

export function listBackfillEventRows(
  db: D1Database,
  roomId: string,
  limit: number,
  maxDepth?: number | null,
): Promise<StoredPduRow[]> {
  if (typeof maxDepth === "number") {
    return executeKyselyQuery<StoredPduRow>(
      db,
      asCompiledQuery(sql<StoredPduRow>`
        SELECT event_id, room_id, sender, event_type, state_key, content,
               origin_server_ts, depth, auth_events, prev_events, event_origin,
               event_membership, prev_state, hashes, signatures
        FROM events
        WHERE room_id = ${roomId} AND depth < ${maxDepth}
        ORDER BY depth DESC
        LIMIT ${limit}
      `),
    );
  }

  return executeKyselyQuery<StoredPduRow>(
    db,
    asCompiledQuery(sql<StoredPduRow>`
      SELECT event_id, room_id, sender, event_type, state_key, content,
             origin_server_ts, depth, auth_events, prev_events, event_origin,
             event_membership, prev_state, hashes, signatures
      FROM events
      WHERE room_id = ${roomId}
      ORDER BY depth DESC
      LIMIT ${limit}
    `),
  );
}
