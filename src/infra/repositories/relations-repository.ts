import { sql, type RawBuilder } from "kysely";
import {
  createKyselyBuilder,
  executeKyselyQuery,
  executeKyselyQueryFirst,
  executeKyselyRun,
  type CompiledQuery,
} from "../../infra/db/kysely";
import { getDefaultRoomVersion } from "../../infra/db/room-versions";
import type { ThreadSubscriptionState } from "../../shared/types/client";
import type { RelationCursor, RelationEvent } from "../../shared/types/events";
import type { PDU, RoomId, UserId } from "../../shared/types";
import { encodeUnpaddedBase64 } from "../../shared/utils/crypto";
import { toEventId, toRoomId, toUserId } from "../../shared/utils/ids";
import { extractServerNameFromMatrixId } from "../../shared/utils/matrix-ids";
import { getFederationEventRowById, toFederationPduFromRow } from "./federation-events-repository";

const THREAD_SUBSCRIPTIONS_EVENT_TYPE = "io.element.msc4306.thread_subscriptions";

interface EventRelationRow {
  event_id: string;
  relates_to_id: string;
  relation_type: string;
}

interface EventRow {
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
  stream_ordering?: number;
}

interface RoomRow {
  room_id: string;
  room_version: string;
}

interface MembershipRow {
  room_id: string;
  user_id: string;
  membership: string;
  event_id: string;
}

interface AccountDataRow {
  user_id: string;
  room_id: string;
  event_type: string;
  content: string;
  deleted: number;
}

interface RelationsDatabase {
  event_relations: EventRelationRow;
  events: EventRow;
  rooms: RoomRow;
  room_memberships: MembershipRow;
  account_data: AccountDataRow;
}

interface RelationEventRow {
  event_id: string;
  event_type: string;
  sender: string;
  origin_server_ts: number;
  content: string;
  stream_ordering: number;
}

interface ThreadRow extends RelationEventRow {
  latest_event_id: string;
  latest_event_type: string;
  latest_event_sender: string;
  latest_event_origin_server_ts: number;
  latest_event_content: string;
}

export interface RelationChunkEvent extends RelationEvent {
  room_id: RoomId;
  unsigned?: Record<string, unknown>;
}

const qb = createKyselyBuilder<RelationsDatabase>();

function asCompiledQuery<T>(query: RawBuilder<T>): CompiledQuery {
  return {
    compile: () => query.compile(qb),
  };
}

function parseJsonObject(value: string | null | undefined): Record<string, unknown> {
  if (!value) {
    return {};
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function parseThreadSubscriptionState(value: unknown): ThreadSubscriptionState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  return {
    automatic: record["automatic"] === true,
    subscribed: record["subscribed"] !== false,
    ...(typeof record["unsubscribed_after"] === "number"
      ? { unsubscribed_after: record["unsubscribed_after"] }
      : {}),
    ...(typeof record["automatic_event_id"] === "string"
      ? { automatic_event_id: toEventId(record["automatic_event_id"]) ?? undefined }
      : {}),
  };
}

function parseThreadSubscriptionsContent(
  rawContent: string | null | undefined,
): Record<string, ThreadSubscriptionState> {
  if (!rawContent) {
    return {};
  }

  try {
    const parsed = JSON.parse(rawContent) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    const subscriptions: Record<string, ThreadSubscriptionState> = {};
    for (const [threadRootId, value] of Object.entries(parsed as Record<string, unknown>)) {
      const record = parseThreadSubscriptionState(value);
      if (record) {
        subscriptions[threadRootId] = record;
      }
    }
    return subscriptions;
  } catch {
    return {};
  }
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
  const rows = await executeKyselyQuery<Pick<EventRelationRow, "relation_type" | "event_id">>(
    db,
    qb
      .selectFrom("event_relations")
      .select(["relation_type", "event_id"])
      .where("relates_to_id", "=", eventId),
  );

  if (rows.length === 0) {
    return undefined;
  }

  const children: Record<string, number> = {};
  const childEventIds: string[] = [];
  for (const row of rows) {
    children[row.relation_type] = (children[row.relation_type] ?? 0) + 1;
    childEventIds.push(row.event_id);
  }

  return {
    children,
    children_hash: await computeChildrenHash(childEventIds),
  };
}

export async function augmentRelationEvent(db: D1Database, event: PDU): Promise<PDU> {
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

export async function getParentRelationEventId(
  db: D1Database,
  eventId: string,
): Promise<string | null> {
  const row = await executeKyselyQueryFirst<Pick<EventRelationRow, "relates_to_id">>(
    db,
    qb
      .selectFrom("event_relations")
      .select("relates_to_id")
      .where("event_id", "=", eventId)
      .limit(1),
  );

  return row?.relates_to_id ?? null;
}

export async function listChildRelationEvents(
  db: D1Database,
  roomId: string,
  eventId: string,
  recentFirst: boolean,
): Promise<PDU[]> {
  const rows = await executeKyselyQuery<EventRow>(
    db,
    qb
      .selectFrom("event_relations as r")
      .innerJoin("events as e", "e.event_id", "r.event_id")
      .select([
        "e.event_id",
        "e.room_id",
        "e.sender",
        "e.event_type",
        "e.state_key",
        "e.content",
        "e.origin_server_ts",
        "e.unsigned",
        "e.depth",
        "e.auth_events",
        "e.prev_events",
        "e.event_origin",
        "e.event_membership",
        "e.prev_state",
        "e.hashes",
        "e.signatures",
      ])
      .where("r.relates_to_id", "=", eventId)
      .where("e.room_id", "=", roomId)
      .orderBy("e.origin_server_ts", recentFirst ? "desc" : "asc")
      .orderBy("e.stream_ordering", recentFirst ? "desc" : "asc"),
  );

  return Promise.all(
    rows.flatMap((row) => {
      const typedEventId = toEventId(row.event_id);
      if (!typedEventId) {
        return [];
      }

      const event = toFederationPduFromRow({
        event_id: typedEventId,
        room_id: toRoomId(row.room_id) ?? (row.room_id as PDU["room_id"]),
        sender: toUserId(row.sender) ?? (row.sender as PDU["sender"]),
        event_type: row.event_type,
        state_key: row.state_key,
        content: row.content,
        origin_server_ts: row.origin_server_ts,
        depth: row.depth,
        auth_events: row.auth_events,
        prev_events: row.prev_events,
        event_origin: row.event_origin,
        event_membership: row.event_membership as PDU["membership"] | null,
        prev_state: row.prev_state,
        hashes: row.hashes,
        signatures: row.signatures,
      });

      return [augmentRelationEvent(db, event)];
    }),
  );
}

export async function resolveRelationRoomId(
  db: D1Database,
  eventId: string,
  explicitRoomId?: string,
): Promise<string | null> {
  if (explicitRoomId) {
    return explicitRoomId;
  }

  const typedEventId = toEventId(eventId);
  if (!typedEventId) {
    return null;
  }

  const row = await getFederationEventRowById(db, typedEventId);
  return row?.room_id ?? null;
}

export async function queryRelationEventTree(
  db: D1Database,
  request: {
    eventId: string;
    roomId?: string;
    direction: "up" | "down";
    includeParent?: boolean;
    recentFirst?: boolean;
    maxDepth?: number;
  },
): Promise<{ roomId: string; events: PDU[]; limited: boolean; missingParentId?: string } | null> {
  const requestEventId = toEventId(request.eventId);
  if (!requestEventId) {
    return null;
  }

  const roomId = await resolveRelationRoomId(db, requestEventId, request.roomId);
  if (!roomId) {
    return null;
  }

  const rootRow = await getFederationEventRowById(db, requestEventId);
  if (!rootRow || rootRow.room_id !== roomId) {
    return null;
  }

  const root = await augmentRelationEvent(db, toFederationPduFromRow(rootRow));
  const maxDepth =
    request.maxDepth === undefined || Number.isNaN(request.maxDepth)
      ? 20
      : Math.max(0, Math.min(request.maxDepth, 50));
  const recentFirst = request.recentFirst ?? true;
  const seen = new Set<string>();
  const events: PDU[] = [];

  const addEvent = async (event: PDU | null): Promise<void> => {
    if (!event || seen.has(event.event_id)) {
      return;
    }
    seen.add(event.event_id);
    events.push(await augmentRelationEvent(db, event));
  };

  await addEvent(root);

  if (request.direction === "up") {
    let current = root;
    let remainingDepth = maxDepth;
    while (remainingDepth > 0) {
      const parentId = await getParentRelationEventId(db, current.event_id);
      if (!parentId) {
        break;
      }

      const typedParentId = toEventId(parentId);
      if (!typedParentId) {
        return {
          roomId,
          events,
          limited: false,
          missingParentId: parentId,
        };
      }

      const parentRow = await getFederationEventRowById(db, typedParentId);
      if (!parentRow) {
        return {
          roomId,
          events,
          limited: false,
          missingParentId: parentId,
        };
      }

      await addEvent(toFederationPduFromRow(parentRow));
      current = toFederationPduFromRow(parentRow);
      remainingDepth -= 1;
    }

    return { roomId, events, limited: false };
  }

  if (request.includeParent) {
    const parentId = await getParentRelationEventId(db, root.event_id);
    if (parentId) {
      const typedParentId = toEventId(parentId);
      if (typedParentId) {
        const parentRow = await getFederationEventRowById(db, typedParentId);
        if (parentRow) {
          await addEvent(toFederationPduFromRow(parentRow));
        }
      }
    }
  }

  const queue: Array<{ eventId: string; depth: number }> = [{ eventId: root.event_id, depth: 0 }];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth >= maxDepth) {
      continue;
    }

    const children = await listChildRelationEvents(db, roomId, current.eventId, recentFirst);
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

export async function getAuthChainForRelations(db: D1Database, eventIds: string[]): Promise<PDU[]> {
  const seen = new Set<string>();
  const chain: PDU[] = [];
  const queue = [...eventIds];

  while (queue.length > 0) {
    const eventId = queue.shift();
    if (!eventId || seen.has(eventId)) {
      continue;
    }
    seen.add(eventId);

    const row = await getFederationEventRowById(db, eventId);
    if (!row) {
      continue;
    }

    const event = toFederationPduFromRow(row);
    chain.push(event);
    for (const authEventId of event.auth_events) {
      if (!seen.has(authEventId)) {
        queue.push(authEventId);
      }
    }
  }

  return chain;
}

export async function getRemoteServersForRelationRoom(
  db: D1Database,
  roomId: string,
  localServerName: string,
): Promise<string[]> {
  const rows = await executeKyselyQuery<{ user_id: string }>(
    db,
    asCompiledQuery(sql<{ user_id: string }>`
      WITH memberships AS (
        SELECT user_id
        FROM room_memberships
        WHERE room_id = ${roomId} AND membership IN ('join', 'invite', 'knock')
        UNION
        SELECT rs.state_key AS user_id
        FROM room_state rs
        INNER JOIN events e ON e.event_id = rs.event_id
        WHERE rs.room_id = ${roomId}
          AND rs.event_type = 'm.room.member'
          AND json_extract(e.content, '$.membership') IN ('join', 'invite', 'knock')
      )
      SELECT DISTINCT user_id FROM memberships
    `),
  );

  return Array.from(
    new Set(
      rows
        .map((row) => extractServerNameFromMatrixId(row.user_id))
        .filter(
          (serverName): serverName is string => !!serverName && serverName !== localServerName,
        ),
    ),
  ).toSorted();
}

export async function getRoomVersionForRelations(db: D1Database, roomId: string): Promise<string> {
  const row = await executeKyselyQueryFirst<Pick<RoomRow, "room_version">>(
    db,
    qb.selectFrom("rooms").select("room_version").where("room_id", "=", roomId).limit(1),
  );

  return row?.room_version ?? getDefaultRoomVersion();
}

export async function getRoomMembershipForRelations(
  db: D1Database,
  roomId: string,
  userId: UserId,
): Promise<string | null> {
  const row = await executeKyselyQueryFirst<Pick<MembershipRow, "membership">>(
    db,
    qb
      .selectFrom("room_memberships")
      .select("membership")
      .where("room_id", "=", roomId)
      .where("user_id", "=", userId)
      .limit(1),
  );

  return row?.membership ?? null;
}

function toRelationEvent(row: RelationEventRow, roomId: string): RelationChunkEvent {
  const eventId = toEventId(row.event_id);
  const sender = toUserId(row.sender);
  const typedRoomId = toRoomId(roomId);
  if (!eventId || !sender || !typedRoomId) {
    throw new TypeError("Relation row contains invalid Matrix identifiers");
  }

  return {
    event_id: eventId,
    type: row.event_type,
    sender,
    origin_server_ts: row.origin_server_ts,
    content: parseJsonObject(row.content),
    room_id: typedRoomId,
  };
}

export async function listRelationEvents(
  db: D1Database,
  input: {
    roomId: string;
    eventId: string;
    relType?: string;
    eventType?: string;
    cursor?: RelationCursor | null;
    limit: number;
    dir: "f" | "b";
  },
): Promise<{ chunk: RelationChunkEvent[]; nextBatch?: string }> {
  let query = qb
    .selectFrom("events as e")
    .innerJoin("event_relations as r", "r.event_id", "e.event_id")
    .select([
      "e.event_id",
      "e.event_type",
      "e.sender",
      "e.origin_server_ts",
      "e.content",
      "e.stream_ordering",
    ])
    .where("e.room_id", "=", input.roomId)
    .where("r.relates_to_id", "=", input.eventId);

  if (input.relType) {
    query = query.where("r.relation_type", "=", input.relType);
  }
  if (input.eventType) {
    query = query.where("e.event_type", "=", input.eventType);
  }
  if (input.cursor) {
    query = query.where(input.cursor.column, input.dir === "b" ? "<" : ">", input.cursor.value);
  }

  const orderColumn = input.cursor?.column ?? "origin_server_ts";
  const rows = await executeKyselyQuery<RelationEventRow>(
    db,
    query
      .orderBy(orderColumn, input.dir === "b" ? "desc" : "asc")
      .orderBy("e.stream_ordering", input.dir === "b" ? "desc" : "asc")
      .limit(input.limit + 1),
  );

  const hasMore = rows.length > input.limit;
  const events = rows.slice(0, input.limit).map((row) => toRelationEvent(row, input.roomId));
  if (!hasMore || events.length === 0) {
    return { chunk: events };
  }

  const lastEvent = rows[Math.min(input.limit, rows.length) - 1];
  const nextValue =
    orderColumn === "stream_ordering"
      ? (lastEvent?.stream_ordering ?? 0)
      : (lastEvent?.origin_server_ts ?? 0);

  return {
    chunk: events,
    nextBatch: orderColumn === "stream_ordering" ? `s${nextValue}` : String(nextValue),
  };
}

export async function listThreadRoots(
  db: D1Database,
  input: {
    roomId: string;
    userId: string;
    limit: number;
    include: "all" | "participated";
  },
): Promise<RelationChunkEvent[]> {
  const participatedFilter =
    input.include === "participated"
      ? sql`
          AND (e.sender = ${input.userId} OR EXISTS (
            SELECT 1
            FROM events r
            INNER JOIN event_relations rel ON rel.event_id = r.event_id
            WHERE rel.relates_to_id = e.event_id
              AND rel.relation_type = 'm.thread'
              AND r.sender = ${input.userId}
          ))
        `
      : sql``;

  const rows = await executeKyselyQuery<ThreadRow>(
    db,
    asCompiledQuery(sql<ThreadRow>`
      SELECT DISTINCT
        e.event_id,
        e.event_type,
        e.sender,
        e.origin_server_ts,
        e.content,
        latest.event_id AS latest_event_id,
        latest.event_type AS latest_event_type,
        latest.sender AS latest_event_sender,
        latest.origin_server_ts AS latest_event_origin_server_ts,
        latest.content AS latest_event_content,
        latest.stream_ordering
      FROM events e
      INNER JOIN events latest ON latest.event_id = (
        SELECT reply.event_id
        FROM event_relations rel
        INNER JOIN events reply ON reply.event_id = rel.event_id
        WHERE rel.relates_to_id = e.event_id
          AND rel.relation_type = 'm.thread'
          AND reply.room_id = e.room_id
        ORDER BY reply.origin_server_ts DESC, reply.stream_ordering DESC
        LIMIT 1
      )
      WHERE e.room_id = ${input.roomId}
        AND EXISTS (
          SELECT 1
          FROM event_relations r
          WHERE r.relates_to_id = e.event_id AND r.relation_type = 'm.thread'
        )
        ${participatedFilter}
      ORDER BY latest.origin_server_ts DESC, latest.stream_ordering DESC
      LIMIT ${input.limit}
    `),
  );

  return rows.map((row) => {
    const thread = toRelationEvent(row, input.roomId);
    return {
      ...thread,
      unsigned: {
        "m.relations": {
          "m.thread": {
            latest_event: {
              event_id: toEventId(row.latest_event_id) ?? row.latest_event_id,
              type: row.latest_event_type,
              sender: toUserId(row.latest_event_sender) ?? row.latest_event_sender,
              origin_server_ts: row.latest_event_origin_server_ts,
              content: parseJsonObject(row.latest_event_content),
              room_id: toRoomId(input.roomId) ?? input.roomId,
            },
          },
        },
      },
    };
  });
}

export async function getThreadSubscriptionContent(
  db: D1Database,
  userId: UserId,
  roomId: RoomId,
): Promise<Record<string, ThreadSubscriptionState>> {
  const existing = await executeKyselyQueryFirst<Pick<AccountDataRow, "content">>(
    db,
    qb
      .selectFrom("account_data")
      .select("content")
      .where("user_id", "=", userId)
      .where("room_id", "=", roomId)
      .where("event_type", "=", THREAD_SUBSCRIPTIONS_EVENT_TYPE)
      .where("deleted", "=", 0)
      .limit(1),
  );

  return existing ? parseThreadSubscriptionsContent(existing.content) : {};
}

export async function putThreadSubscriptionContent(
  db: D1Database,
  userId: UserId,
  roomId: RoomId,
  content: Record<string, ThreadSubscriptionState>,
): Promise<void> {
  await executeKyselyRun(
    db,
    qb
      .insertInto("account_data")
      .values({
        user_id: userId,
        room_id: roomId,
        event_type: THREAD_SUBSCRIPTIONS_EVENT_TYPE,
        content: JSON.stringify(content),
        deleted: 0,
      })
      .onConflict((oc) =>
        oc.columns(["user_id", "room_id", "event_type"]).doUpdateSet({
          content: (eb) => eb.ref("excluded.content"),
          deleted: 0,
        }),
      ),
  );
}

export async function threadRootExists(
  db: D1Database,
  roomId: RoomId,
  eventId: string,
): Promise<boolean> {
  const row = await executeKyselyQueryFirst<Pick<EventRow, "event_id">>(
    db,
    qb
      .selectFrom("events")
      .select("event_id")
      .where("room_id", "=", roomId)
      .where("event_id", "=", eventId)
      .limit(1),
  );

  return row !== null;
}

export async function getThreadReplyStreamOrdering(
  db: D1Database,
  roomId: RoomId,
  automaticEventId: string,
  threadRootId: string,
): Promise<number | null> {
  const row = await executeKyselyQueryFirst<{ stream_ordering: number }>(
    db,
    asCompiledQuery(sql<{ stream_ordering: number }>`
      SELECT e.stream_ordering
      FROM events e
      INNER JOIN event_relations r ON r.event_id = e.event_id
      WHERE e.room_id = ${roomId}
        AND e.event_id = ${automaticEventId}
        AND r.relation_type = 'm.thread'
        AND r.relates_to_id = ${threadRootId}
      LIMIT 1
    `),
  );

  return row?.stream_ordering ?? null;
}

export async function getLatestThreadStreamOrdering(
  db: D1Database,
  roomId: RoomId,
  threadRootId: string,
): Promise<number> {
  const row = await executeKyselyQueryFirst<{ max_stream_ordering: number | null }>(
    db,
    asCompiledQuery(sql<{ max_stream_ordering: number | null }>`
      SELECT MAX(stream_ordering) as max_stream_ordering
      FROM events e
      WHERE e.room_id = ${roomId}
        AND (
          e.event_id = ${threadRootId}
          OR EXISTS (
            SELECT 1
            FROM event_relations r
            WHERE r.event_id = e.event_id
              AND r.relation_type = 'm.thread'
              AND r.relates_to_id = ${threadRootId}
          )
        )
    `),
  );

  return row?.max_stream_ordering ?? 0;
}
