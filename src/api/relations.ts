// Relations and Threads API
// Implements: https://spec.matrix.org/v1.12/client-server-api/#aggregations-of-child-events
//
// Relations allow events to reference other events (replies, reactions, threads, edits)

import { Hono } from "hono";
import type { AppEnv } from "../types";
import type { ThreadSubscriptionState } from "../types/client";
import type { RelationCursor, RelationEvent } from "../types/events";
import { Errors } from "../utils/errors";
import { requireAuth } from "../middleware/auth";
import { buildSyncToken, parseSyncToken } from "../matrix/application/features/sync/contracts";
import {
  fetchFederatedEventRelationships,
  getRemoteServersForRoom,
  getRoomVersionForRelationships,
  queryEventRelationships,
  type EventRelationshipsRequest,
} from "../matrix/application/relationship-service";

const app = new Hono<AppEnv>();
const THREAD_SUBSCRIPTIONS_EVENT_TYPE = "io.element.msc4306.thread_subscriptions";

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
      ? { automatic_event_id: record["automatic_event_id"] }
      : {}),
  };
}

function parseThreadSubscriptionsContent(
  rawContent: string,
): Record<string, ThreadSubscriptionState> {
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

async function getThreadSubscriptionContent(
  db: D1Database,
  userId: string,
  roomId: string,
): Promise<Record<string, ThreadSubscriptionState>> {
  const existing = await db
    .prepare(`
      SELECT content FROM account_data
      WHERE user_id = ? AND room_id = ? AND event_type = ? AND deleted = 0
    `)
    .bind(userId, roomId, THREAD_SUBSCRIPTIONS_EVENT_TYPE)
    .first<{ content: string }>();

  return existing ? parseThreadSubscriptionsContent(existing.content) : {};
}

async function putThreadSubscriptionContent(
  db: D1Database,
  userId: string,
  roomId: string,
  content: Record<string, ThreadSubscriptionState>,
): Promise<void> {
  await db
    .prepare(`
      INSERT INTO account_data (user_id, room_id, event_type, content, deleted)
      VALUES (?, ?, ?, ?, 0)
      ON CONFLICT (user_id, room_id, event_type) DO UPDATE SET
        content = excluded.content,
        deleted = 0
    `)
    .bind(userId, roomId, THREAD_SUBSCRIPTIONS_EVENT_TYPE, JSON.stringify(content))
    .run();
}

// ============================================
// Types
// ============================================

export type { RelationEvent };

function parseRelationCursor(token: string | undefined): RelationCursor | null {
  if (!token) {
    return null;
  }

  if (token.startsWith("s")) {
    return {
      value: parseSyncToken(token).events,
      column: "stream_ordering",
    };
  }

  const parsed = Number.parseInt(token, 10);
  if (Number.isNaN(parsed)) {
    return null;
  }

  return {
    value: parsed,
    column: "origin_server_ts",
  };
}

function parseEventContent(content: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(content) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function buildRelationNextBatch(
  column: RelationCursor["column"] | "origin_server_ts",
  value: number,
): string {
  if (column === "stream_ordering") {
    return buildSyncToken(value, 0, 0);
  }

  return String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseEventRelationshipsRequest(input: unknown): EventRelationshipsRequest | null {
  if (!isRecord(input) || typeof input.event_id !== "string") {
    return null;
  }

  const direction = input.direction === "up" ? "up" : "down";
  return {
    eventId: input.event_id,
    ...(typeof input.room_id === "string" ? { roomId: input.room_id } : {}),
    direction,
    ...(typeof input.include_parent === "boolean" ? { includeParent: input.include_parent } : {}),
    ...(typeof input.recent_first === "boolean" ? { recentFirst: input.recent_first } : {}),
    ...(typeof input.max_depth === "number" ? { maxDepth: input.max_depth } : {}),
  };
}

// ============================================
// Endpoints
// ============================================

// POST /_matrix/client/unstable/event_relationships - MSC2836 event relationships walker
app.post("/_matrix/client/unstable/event_relationships", requireAuth(), async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  const request = parseEventRelationshipsRequest(body);
  if (!request) {
    return Errors.badJson().toResponse();
  }

  let result = await queryEventRelationships(c.env.DB, request);
  const roomId = result?.roomId ?? request.roomId;
  if (!roomId) {
    return Errors.notFound("Event not found").toResponse();
  }

  const membership = await c.env.DB.prepare(
    `
        SELECT membership
        FROM room_memberships
        WHERE room_id = ? AND user_id = ?
      `,
  )
    .bind(roomId, c.get("userId"))
    .first<{ membership: string }>();

  if (!membership || !["join", "leave"].includes(membership.membership)) {
    return Errors.forbidden("Not a member of this room").toResponse();
  }

  const localServerName = c.env.SERVER_NAME;
  const remoteServers = await getRemoteServersForRoom(c.env.DB, roomId, localServerName);
  const roomVersion = await getRoomVersionForRelationships(c.env.DB, roomId);

  if (request.direction === "down" && !!request.roomId && remoteServers.length > 0) {
    await fetchFederatedEventRelationships(
      c.env.DB,
      c.env.CACHE,
      localServerName,
      roomVersion,
      remoteServers[0],
      { ...request, roomId },
    );
    result = await queryEventRelationships(c.env.DB, { ...request, roomId });
  } else if (request.direction === "up" && remoteServers.length > 0) {
    let missingParentId = result?.missingParentId;
    const attemptedParents = new Set<string>();
    while (missingParentId && !attemptedParents.has(missingParentId)) {
      attemptedParents.add(missingParentId);
      const fetched = await fetchFederatedEventRelationships(
        c.env.DB,
        c.env.CACHE,
        localServerName,
        roomVersion,
        remoteServers[0],
        {
          eventId: missingParentId,
          roomId,
          direction: "up",
          maxDepth: request.maxDepth,
          recentFirst: request.recentFirst,
        },
      );
      if (!fetched) {
        break;
      }
      result = await queryEventRelationships(c.env.DB, { ...request, roomId });
      missingParentId = result?.missingParentId;
    }
  }

  if (!result) {
    return Errors.notFound("Event not found").toResponse();
  }

  return c.json({
    events: result.events,
    limited: result.limited,
  });
});

// GET /_matrix/client/v1/rooms/:roomId/relations/:eventId - Get all relations
app.get("/_matrix/client/v1/rooms/:roomId/relations/:eventId", requireAuth(), async (c) => {
  const userId = c.get("userId");
  const roomId = c.req.param("roomId");
  const eventId = c.req.param("eventId");
  const db = c.env.DB;

  // Check membership
  const membership = await db
    .prepare(`
    SELECT membership FROM room_memberships WHERE room_id = ? AND user_id = ?
  `)
    .bind(roomId, userId)
    .first<{ membership: string }>();

  if (!membership || !["join", "leave"].includes(membership.membership)) {
    return Errors.forbidden("Not a member of this room").toResponse();
  }

  // Get pagination params
  const from = c.req.query("from");
  // Note: 'to' pagination param reserved for future use
  void c.req.query("to");
  const limit = Math.min(parseInt(c.req.query("limit") || "50"), 100);
  const dir = c.req.query("dir") || "b"; // backwards by default

  const cursor = parseRelationCursor(from);

  // Query relations
  let query = `
    SELECT e.event_id, e.event_type, e.sender, e.origin_server_ts, e.content, e.stream_ordering
    FROM events e
    INNER JOIN event_relations r ON r.event_id = e.event_id
    WHERE e.room_id = ? AND r.relates_to_id = ?
  `;
  const params: Array<string | number> = [roomId, eventId];

  if (cursor) {
    if (dir === "b") {
      query += ` AND e.${cursor.column} < ?`;
    } else {
      query += ` AND e.${cursor.column} > ?`;
    }
    params.push(cursor.value);
  }

  const orderColumn = cursor?.column ?? "origin_server_ts";
  query += ` ORDER BY e.${orderColumn} ${dir === "b" ? "DESC" : "ASC"}, e.stream_ordering ${dir === "b" ? "DESC" : "ASC"} LIMIT ?`;
  params.push(limit + 1);

  const results = await db
    .prepare(query)
    .bind(...params)
    .all<{
      event_id: string;
      event_type: string;
      sender: string;
      origin_server_ts: number;
      content: string;
      stream_ordering: number;
    }>();

  const hasMore = results.results.length > limit;
  const events = results.results.slice(0, limit).map((e) => ({
    event_id: e.event_id,
    type: e.event_type,
    sender: e.sender,
    origin_server_ts: e.origin_server_ts,
    content: parseEventContent(e.content),
    room_id: roomId,
  }));

  const response: any = {
    chunk: events,
  };

  if (hasMore && events.length > 0) {
    const lastEvent = results.results[Math.min(limit, results.results.length) - 1];
    response.next_batch = buildRelationNextBatch(
      orderColumn,
      orderColumn === "stream_ordering"
        ? (lastEvent?.stream_ordering ?? 0)
        : (lastEvent?.origin_server_ts ?? 0),
    );
  }

  return c.json(response);
});

// GET /_matrix/client/v1/rooms/:roomId/relations/:eventId/:relType - Get relations by type
app.get(
  "/_matrix/client/v1/rooms/:roomId/relations/:eventId/:relType",
  requireAuth(),
  async (c) => {
    const userId = c.get("userId");
    const roomId = c.req.param("roomId");
    const eventId = c.req.param("eventId");
    const relType = c.req.param("relType");
    const db = c.env.DB;

    // Check membership
    const membership = await db
      .prepare(`
    SELECT membership FROM room_memberships WHERE room_id = ? AND user_id = ?
  `)
      .bind(roomId, userId)
      .first<{ membership: string }>();

    if (!membership || !["join", "leave"].includes(membership.membership)) {
      return Errors.forbidden("Not a member of this room").toResponse();
    }

    // Get pagination params
    const limit = Math.min(parseInt(c.req.query("limit") || "50"), 100);
    const dir = c.req.query("dir") || "b";
    const cursor = parseRelationCursor(c.req.query("from"));

    // Query relations by type
    const results = await db
      .prepare(`
    SELECT e.event_id, e.event_type, e.sender, e.origin_server_ts, e.content, e.stream_ordering
    FROM events e
    INNER JOIN event_relations r ON r.event_id = e.event_id
    WHERE e.room_id = ? AND r.relates_to_id = ? AND r.relation_type = ?
    ${cursor ? `AND e.${cursor.column} ${dir === "b" ? "<" : ">"} ?` : ""}
    ORDER BY e.${cursor?.column ?? "origin_server_ts"} ${dir === "b" ? "DESC" : "ASC"}, e.stream_ordering ${dir === "b" ? "DESC" : "ASC"}
    LIMIT ?
  `)
      .bind(...([roomId, eventId, relType, ...(cursor ? [cursor.value] : []), limit + 1] as const))
      .all<{
        event_id: string;
        event_type: string;
        sender: string;
        origin_server_ts: number;
        content: string;
        stream_ordering: number;
      }>();

    const hasMore = results.results.length > limit;
    const events = results.results.slice(0, limit).map((e) => ({
      event_id: e.event_id,
      type: e.event_type,
      sender: e.sender,
      origin_server_ts: e.origin_server_ts,
      content: parseEventContent(e.content),
      room_id: roomId,
    }));

    const response: any = {
      chunk: events,
    };

    if (hasMore && events.length > 0) {
      const lastEvent = results.results[Math.min(limit, results.results.length) - 1];
      const orderColumn = cursor?.column ?? "origin_server_ts";
      response.next_batch = buildRelationNextBatch(
        orderColumn,
        orderColumn === "stream_ordering"
          ? (lastEvent?.stream_ordering ?? 0)
          : (lastEvent?.origin_server_ts ?? 0),
      );
    }

    return c.json(response);
  },
);

// GET /_matrix/client/v1/rooms/:roomId/relations/:eventId/:relType/:eventType - Get relations by type and event type
app.get(
  "/_matrix/client/v1/rooms/:roomId/relations/:eventId/:relType/:eventType",
  requireAuth(),
  async (c) => {
    const userId = c.get("userId");
    const roomId = c.req.param("roomId");
    const eventId = c.req.param("eventId");
    const relType = c.req.param("relType");
    const eventType = c.req.param("eventType");
    const db = c.env.DB;

    // Check membership
    const membership = await db
      .prepare(`
    SELECT membership FROM room_memberships WHERE room_id = ? AND user_id = ?
  `)
      .bind(roomId, userId)
      .first<{ membership: string }>();

    if (!membership || !["join", "leave"].includes(membership.membership)) {
      return Errors.forbidden("Not a member of this room").toResponse();
    }

    const limit = Math.min(parseInt(c.req.query("limit") || "50"), 100);
    const dir = c.req.query("dir") || "b";
    const cursor = parseRelationCursor(c.req.query("from"));

    // Query relations by type and event type
    const results = await db
      .prepare(`
    SELECT e.event_id, e.event_type, e.sender, e.origin_server_ts, e.content, e.stream_ordering
    FROM events e
    INNER JOIN event_relations r ON r.event_id = e.event_id
    WHERE e.room_id = ? AND r.relates_to_id = ? AND r.relation_type = ? AND e.event_type = ?
    ${cursor ? `AND e.${cursor.column} ${dir === "b" ? "<" : ">"} ?` : ""}
    ORDER BY e.${cursor?.column ?? "origin_server_ts"} ${dir === "b" ? "DESC" : "ASC"}, e.stream_ordering ${dir === "b" ? "DESC" : "ASC"}
    LIMIT ?
  `)
      .bind(
        ...([
          roomId,
          eventId,
          relType,
          eventType,
          ...(cursor ? [cursor.value] : []),
          limit + 1,
        ] as const),
      )
      .all<{
        event_id: string;
        event_type: string;
        sender: string;
        origin_server_ts: number;
        content: string;
        stream_ordering: number;
      }>();

    const hasMore = results.results.length > limit;
    const events = results.results.slice(0, limit).map((e) => ({
      event_id: e.event_id,
      type: e.event_type,
      sender: e.sender,
      origin_server_ts: e.origin_server_ts,
      content: parseEventContent(e.content),
      room_id: roomId,
    }));

    const response: any = {
      chunk: events,
    };

    if (hasMore && events.length > 0) {
      const lastEvent = results.results[Math.min(limit, results.results.length) - 1];
      const orderColumn = cursor?.column ?? "origin_server_ts";
      response.next_batch = buildRelationNextBatch(
        orderColumn,
        orderColumn === "stream_ordering"
          ? (lastEvent?.stream_ordering ?? 0)
          : (lastEvent?.origin_server_ts ?? 0),
      );
    }

    return c.json(response);
  },
);

// GET /_matrix/client/v1/rooms/:roomId/threads - List threads in room
app.get("/_matrix/client/v1/rooms/:roomId/threads", requireAuth(), async (c) => {
  const userId = c.get("userId");
  const roomId = c.req.param("roomId");
  const db = c.env.DB;

  // Check membership
  const membership = await db
    .prepare(`
    SELECT membership FROM room_memberships WHERE room_id = ? AND user_id = ?
  `)
    .bind(roomId, userId)
    .first<{ membership: string }>();

  if (!membership || !["join", "leave"].includes(membership.membership)) {
    return Errors.forbidden("Not a member of this room").toResponse();
  }

  const limit = Math.min(parseInt(c.req.query("limit") || "50"), 100);
  const include = c.req.query("include") || "all"; // 'all' or 'participated'

  // Find thread roots (events that have replies with m.thread relation)
  let query = `
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
      latest.stream_ordering AS latest_event_stream_ordering
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
    WHERE e.room_id = ? AND EXISTS (
      SELECT 1 FROM event_relations r
      WHERE r.relates_to_id = e.event_id AND r.relation_type = 'm.thread'
    )
  `;
  const params: Array<string | number> = [roomId];

  if (include === "participated") {
    query += ` AND (e.sender = ? OR EXISTS (
      SELECT 1
      FROM events r
      INNER JOIN event_relations rel ON rel.event_id = r.event_id
      WHERE rel.relates_to_id = e.event_id AND rel.relation_type = 'm.thread' AND r.sender = ?
    ))`;
    params.push(userId, userId);
  }

  query += ` ORDER BY latest.origin_server_ts DESC, latest.stream_ordering DESC LIMIT ?`;
  params.push(limit);

  const results = await db
    .prepare(query)
    .bind(...params)
    .all<{
      event_id: string;
      event_type: string;
      sender: string;
      origin_server_ts: number;
      content: string;
      latest_event_id: string;
      latest_event_type: string;
      latest_event_sender: string;
      latest_event_origin_server_ts: number;
      latest_event_content: string;
    }>();

  const threads = results.results.map((e) => ({
    event_id: e.event_id,
    type: e.event_type,
    sender: e.sender,
    origin_server_ts: e.origin_server_ts,
    content: parseEventContent(e.content),
    room_id: roomId,
    unsigned: {
      "m.relations": {
        "m.thread": {
          latest_event: {
            event_id: e.latest_event_id,
            type: e.latest_event_type,
            sender: e.latest_event_sender,
            origin_server_ts: e.latest_event_origin_server_ts,
            content: parseEventContent(e.latest_event_content),
            room_id: roomId,
          },
        },
      },
    },
  }));

  return c.json({
    chunk: threads,
  });
});

app.put(
  "/_matrix/client/unstable/io.element.msc4306/rooms/:roomId/thread/:threadRootId/subscription",
  requireAuth(),
  async (c) => {
    const userId = c.get("userId");
    const roomId = decodeURIComponent(c.req.param("roomId"));
    const threadRootId = decodeURIComponent(c.req.param("threadRootId"));
    const db = c.env.DB;

    const membership = await db
      .prepare(`
        SELECT membership FROM room_memberships WHERE room_id = ? AND user_id = ?
      `)
      .bind(roomId, userId)
      .first<{ membership: string }>();

    if (!membership || membership.membership !== "join") {
      return Errors.forbidden("Not a member of this room").toResponse();
    }

    const threadRoot = await db
      .prepare(`
        SELECT event_id FROM events WHERE room_id = ? AND event_id = ?
      `)
      .bind(roomId, threadRootId)
      .first<{ event_id: string }>();

    if (!threadRoot) {
      return Errors.notFound("Thread root not found").toResponse();
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return Errors.badJson().toResponse();
    }

    const requestedAutomaticEventId =
      body && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, unknown>)["automatic"]
        : undefined;

    const content = await getThreadSubscriptionContent(db, userId, roomId);

    if (typeof requestedAutomaticEventId === "string") {
      if (requestedAutomaticEventId === threadRootId) {
        return c.json(
          {
            errcode: "IO.ELEMENT.MSC4306.M_NOT_IN_THREAD",
            error: "Automatic subscription event must be a thread reply",
          },
          400,
        );
      }

      const automaticEvent = await db
        .prepare(`
          SELECT e.stream_ordering
          FROM events e
          INNER JOIN event_relations r ON r.event_id = e.event_id
          WHERE e.room_id = ? AND e.event_id = ? AND r.relation_type = 'm.thread' AND r.relates_to_id = ?
        `)
        .bind(roomId, requestedAutomaticEventId, threadRootId)
        .first<{ stream_ordering: number }>();

      if (!automaticEvent) {
        return c.json(
          {
            errcode: "IO.ELEMENT.MSC4306.M_NOT_IN_THREAD",
            error: "Automatic subscription event is not in the requested thread",
          },
          400,
        );
      }

      const previousSubscription = content[threadRootId];
      if (
        previousSubscription?.unsubscribed_after !== undefined &&
        automaticEvent.stream_ordering <= previousSubscription.unsubscribed_after
      ) {
        return c.json(
          {
            errcode: "IO.ELEMENT.MSC4306.M_CONFLICTING_UNSUBSCRIPTION",
            error: "Automatic subscription conflicts with a later unsubscription",
          },
          409,
        );
      }

      content[threadRootId] = {
        automatic: true,
        subscribed: true,
        automatic_event_id: requestedAutomaticEventId,
      };
    } else {
      content[threadRootId] = {
        automatic: false,
        subscribed: true,
      };
    }

    await putThreadSubscriptionContent(db, userId, roomId, content);

    return c.json({});
  },
);

app.get(
  "/_matrix/client/unstable/io.element.msc4306/rooms/:roomId/thread/:threadRootId/subscription",
  requireAuth(),
  async (c) => {
    const userId = c.get("userId");
    const roomId = decodeURIComponent(c.req.param("roomId"));
    const threadRootId = decodeURIComponent(c.req.param("threadRootId"));
    const db = c.env.DB;

    const threadRoot = await db
      .prepare(`SELECT event_id FROM events WHERE room_id = ? AND event_id = ?`)
      .bind(roomId, threadRootId)
      .first<{ event_id: string }>();

    if (!threadRoot) {
      return Errors.notFound("Thread root not found").toResponse();
    }

    const content = await getThreadSubscriptionContent(db, userId, roomId);
    const subscription = content[threadRootId];
    if (!subscription?.subscribed) {
      return Errors.notFound("Thread subscription not found").toResponse();
    }

    return c.json({
      automatic: subscription.automatic,
    });
  },
);

app.delete(
  "/_matrix/client/unstable/io.element.msc4306/rooms/:roomId/thread/:threadRootId/subscription",
  requireAuth(),
  async (c) => {
    const userId = c.get("userId");
    const roomId = decodeURIComponent(c.req.param("roomId"));
    const threadRootId = decodeURIComponent(c.req.param("threadRootId"));
    const db = c.env.DB;

    const content = await getThreadSubscriptionContent(db, userId, roomId);
    const existingSubscription = content[threadRootId];
    if (!existingSubscription?.subscribed) {
      return c.json({});
    }

    const latestThreadEvent = await db
      .prepare(`
        SELECT MAX(stream_ordering) as max_stream_ordering
        FROM events e
        WHERE e.room_id = ? AND (
          e.event_id = ? OR EXISTS (
            SELECT 1
            FROM event_relations r
            WHERE r.event_id = e.event_id AND r.relation_type = 'm.thread' AND r.relates_to_id = ?
          )
        )
      `)
      .bind(roomId, threadRootId, threadRootId)
      .first<{ max_stream_ordering: number | null }>();

    content[threadRootId] = {
      automatic: false,
      subscribed: false,
      unsubscribed_after: latestThreadEvent?.max_stream_ordering ?? 0,
    };

    await putThreadSubscriptionContent(db, userId, roomId, content);
    return c.json({});
  },
);

export default app;
