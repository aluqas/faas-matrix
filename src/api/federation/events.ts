import { Hono } from "hono";
import type { AppEnv, EventId, PDU } from "../../types";
import { Errors } from "../../utils/errors";
import { calculateReferenceHashEventId } from "../../utils/crypto";
import { toEventId, toRoomId } from "../../utils/ids";
import { getAuthChain } from "../../services/database";
import { EventQueryService } from "../../matrix/application/event-query-service";
import { getPartialStateJoinForRoom } from "../../matrix/application/features/partial-state/tracker";
import {
  getFederationEventRowByReference,
  logFederationRouteWarning,
  toFederationPduFromRow,
  type FederationEventRow,
} from "./shared";

const app = new Hono<AppEnv>();
const queries = new EventQueryService();

app.get("/_matrix/federation/v1/event/:eventId", async (c) => {
  const event = await c.env.DB.prepare(
    `SELECT event_id, room_id, sender, event_type, state_key, content,
     origin_server_ts, depth, auth_events, prev_events, event_origin, event_membership,
     prev_state, hashes, signatures
     FROM events WHERE event_id = ?`,
  )
    .bind(c.req.param("eventId"))
    .first<FederationEventRow>();

  if (!event) {
    return Errors.notFound("Event not found").toResponse();
  }

  return c.json({
    origin: c.env.SERVER_NAME,
    origin_server_ts: Date.now(),
    pdus: [toFederationPduFromRow(event)],
  });
});

app.get("/_matrix/federation/v1/state/:roomId", async (c) => {
  const roomId = toRoomId(c.req.param("roomId"));
  if (!roomId) {
    return Errors.invalidParam("roomId", "Invalid room ID").toResponse();
  }
  void c.req.query("event_id");

  const stateEvents = await c.env.DB.prepare(
    `SELECT e.event_id, e.room_id, e.sender, e.event_type, e.state_key, e.content,
     e.origin_server_ts, e.depth, e.auth_events, e.prev_events, e.event_origin,
     e.event_membership, e.prev_state, e.hashes, e.signatures
     FROM room_state rs
     JOIN events e ON rs.event_id = e.event_id
     WHERE rs.room_id = ?`,
  )
    .bind(roomId)
    .all<FederationEventRow>();

  const pdus = stateEvents.results.map(toFederationPduFromRow);
  const authEventIds = new Set<string>();
  for (const pdu of pdus) {
    for (const authId of pdu.auth_events) {
      authEventIds.add(authId);
    }
  }

  const authChain: PDU[] = [];
  for (const authId of authEventIds) {
    const authEvent = await c.env.DB.prepare(
      `SELECT event_id, room_id, sender, event_type, state_key, content,
       origin_server_ts, depth, auth_events, prev_events, event_origin, event_membership,
       prev_state, hashes, signatures
       FROM events WHERE event_id = ?`,
    )
      .bind(authId)
      .first<FederationEventRow>();

    if (authEvent) {
      authChain.push(toFederationPduFromRow(authEvent));
    }
  }

  return c.json({
    origin: c.env.SERVER_NAME,
    origin_server_ts: Date.now(),
    pdus,
    auth_chain: authChain,
  });
});

app.get("/_matrix/federation/v1/state_ids/:roomId", async (c) => {
  const roomId = toRoomId(c.req.param("roomId"));
  const eventId = c.req.query("event_id");
  if (!roomId) {
    return Errors.invalidParam("roomId", "Invalid room ID").toResponse();
  }

  const partialStateJoin = await getPartialStateJoinForRoom(c.env.CACHE, roomId);
  if (eventId && partialStateJoin) {
    return Errors.forbidden("Room state is still partial for this event").toResponse();
  }

  const room = await c.env.DB.prepare(`SELECT room_id, room_version FROM rooms WHERE room_id = ?`)
    .bind(roomId)
    .first<{ room_id: string; room_version: string }>();
  if (!room) {
    return Errors.notFound("Room not found").toResponse();
  }

  const stateEvents = await c.env.DB.prepare(
    `SELECT e.event_id, e.auth_events
     FROM room_state rs
     JOIN events e ON rs.event_id = e.event_id
     WHERE rs.room_id = ?`,
  )
    .bind(roomId)
    .all<{ event_id: string; auth_events: string }>();

  const stateEventIds = stateEvents.results.map((event) => event.event_id);
  const rootAuthEventIds = Array.from(
    new Set(
      stateEvents.results.flatMap((event) => {
        try {
          const authEvents = JSON.parse(event.auth_events) as unknown;
          return Array.isArray(authEvents)
            ? authEvents.filter((authId): authId is string => typeof authId === "string")
            : [];
        } catch {
          return [];
        }
      }),
    ),
  );
  const authChainIds = (await getAuthChain(c.env.DB, rootAuthEventIds)).map(
    (event) => event.event_id,
  );

  return c.json({
    pdu_ids: stateEventIds,
    auth_chain_ids: authChainIds,
  });
});

app.get("/_matrix/federation/v1/event_auth/:roomId/:eventId", async (c) => {
  const roomId = toRoomId(c.req.param("roomId"));
  const eventId = toEventId(c.req.param("eventId"));
  if (!roomId || !eventId) {
    return Errors.invalidParam("roomId", "Invalid room or event ID").toResponse();
  }

  const room = await c.env.DB.prepare(`SELECT room_id, room_version FROM rooms WHERE room_id = ?`)
    .bind(roomId)
    .first<{ room_id: string; room_version: string }>();
  if (!room) {
    return Errors.notFound("Room not found").toResponse();
  }

  const event = await c.env.DB.prepare(
    `SELECT event_id, auth_events FROM events WHERE event_id = ? AND room_id = ?`,
  )
    .bind(eventId, roomId)
    .first<{ event_id: string; auth_events: string }>();
  if (!event) {
    return Errors.notFound("Event not found").toResponse();
  }

  const authChain: PDU[] = [];
  const visited = new Set<string>();
  const toProcess = JSON.parse(event.auth_events) as string[];
  const missingAuthEvents: string[] = [];
  const authChainSummaries: Array<{
    event_id: string;
    calculated_event_id: string;
    type: string;
    state_key?: string;
    origin_server_ts: number;
    depth: number;
    auth_events: string[];
    prev_events: string[];
  }> = [];

  while (toProcess.length > 0) {
    const authId = toProcess.shift()!;
    if (visited.has(authId)) {
      continue;
    }
    visited.add(authId);

    const authEvent = await getFederationEventRowByReference(c.env.DB, authId);
    if (!authEvent) {
      missingAuthEvents.push(authId);
      continue;
    }

    const authEvents = (JSON.parse(authEvent.auth_events) as string[])
      .map((value) => toEventId(value))
      .filter((value): value is EventId => value !== null);
    const prevEvents = (JSON.parse(authEvent.prev_events) as string[])
      .map((value) => toEventId(value))
      .filter((value): value is EventId => value !== null);
    const pdu: PDU = {
      ...toFederationPduFromRow(authEvent),
      auth_events: authEvents,
      prev_events: prevEvents,
    };
    authChain.push(pdu);

    const calculatedEventId = await calculateReferenceHashEventId(
      pdu as unknown as Record<string, unknown>,
      room.room_version,
    );
    authChainSummaries.push({
      event_id: pdu.event_id,
      calculated_event_id: calculatedEventId,
      type: pdu.type,
      state_key: pdu.state_key,
      origin_server_ts: pdu.origin_server_ts,
      depth: pdu.depth,
      auth_events: authEvents,
      prev_events: prevEvents,
    });

    for (const id of authEvents) {
      if (!visited.has(id)) {
        toProcess.push(id);
      }
    }
  }

  await logFederationRouteWarning(c, "event_auth", {
    roomId,
    eventId,
    requestedAuthEvents: (JSON.parse(event.auth_events) as string[])
      .map((value) => toEventId(value))
      .filter((value): value is EventId => value !== null),
    returnedAuthChain: authChainSummaries,
    missingAuthEvents,
  });

  return c.json({ auth_chain: authChain });
});

app.get("/_matrix/federation/v1/backfill/:roomId", async (c) => {
  const roomId = toRoomId(c.req.param("roomId"));
  if (!roomId) {
    return Errors.invalidParam("roomId", "Invalid room ID").toResponse();
  }
  const limit = Math.min(Number.parseInt(c.req.query("limit") ?? "100", 10), 1000);
  const vParam = c.req.query("v");

  const room = await c.env.DB.prepare(`SELECT room_id, room_version FROM rooms WHERE room_id = ?`)
    .bind(roomId)
    .first<{ room_id: string; room_version: string }>();
  if (!room) {
    return Errors.notFound("Room not found").toResponse();
  }

  const startEventIds = vParam
    ? vParam
        .split(",")
        .map((value) => toEventId(value))
        .filter((value): value is EventId => value !== null)
    : [];
  let events: FederationEventRow[];
  if (startEventIds.length > 0) {
    const startEvents = await c.env.DB.prepare(
      `SELECT MIN(depth) as min_depth FROM events WHERE event_id IN (${startEventIds.map(() => "?").join(",")})`,
    )
      .bind(...startEventIds)
      .first<{ min_depth: number }>();

    const maxDepth = startEvents?.min_depth ?? 0;
    events = (
      await c.env.DB.prepare(
        `SELECT event_id, room_id, sender, event_type, state_key, content,
         origin_server_ts, depth, auth_events, prev_events, event_origin, event_membership,
         prev_state, hashes, signatures
         FROM events
         WHERE room_id = ? AND depth < ?
         ORDER BY depth DESC
         LIMIT ?`,
      )
        .bind(roomId, maxDepth, limit)
        .all<FederationEventRow>()
    ).results;
  } else {
    events = (
      await c.env.DB.prepare(
        `SELECT event_id, room_id, sender, event_type, state_key, content,
         origin_server_ts, depth, auth_events, prev_events, event_origin, event_membership,
         prev_state, hashes, signatures
         FROM events
         WHERE room_id = ?
         ORDER BY depth DESC
         LIMIT ?`,
      )
        .bind(roomId, limit)
        .all<FederationEventRow>()
    ).results;
  }

  return c.json({
    origin: c.env.SERVER_NAME,
    origin_server_ts: Date.now(),
    pdus: events.map(toFederationPduFromRow),
  });
});

app.post("/_matrix/federation/v1/get_missing_events/:roomId", async (c) => {
  const roomId = toRoomId(c.req.param("roomId"));
  if (!roomId) {
    return Errors.invalidParam("roomId", "Invalid room ID").toResponse();
  }
  const origin = c.get("federationOrigin" as any) as string | undefined;

  let body: {
    earliest_events?: string[];
    latest_events?: string[];
    limit?: number;
    min_depth?: number;
  };
  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  const room = await c.env.DB.prepare(`SELECT room_id, room_version FROM rooms WHERE room_id = ?`)
    .bind(roomId)
    .first<{ room_id: string; room_version: string }>();
  if (!room) {
    return Errors.notFound("Room not found").toResponse();
  }

  const events = await queries.getMissingEvents(c.env.DB, {
    roomId,
    earliestEvents: (body.earliest_events ?? [])
      .map((value) => toEventId(value))
      .filter((value): value is EventId => value !== null),
    latestEvents: (body.latest_events ?? [])
      .map((value) => toEventId(value))
      .filter((value): value is EventId => value !== null),
    limit: Math.min(body.limit ?? 10, 100),
    minDepth: body.min_depth ?? 0,
    roomVersion: room.room_version,
    requestingServer: origin,
  });

  return c.json({ events });
});

app.get("/_matrix/federation/v1/timestamp_to_event/:roomId", async (c) => {
  const roomId = toRoomId(c.req.param("roomId"));
  if (!roomId) {
    return Errors.invalidParam("roomId", "Invalid room ID").toResponse();
  }
  const ts = Number.parseInt(c.req.query("ts") ?? "0", 10);
  const dir = c.req.query("dir") === "b" ? "b" : "f";

  if (!ts || ts <= 0) {
    return Errors.missingParam("ts").toResponse();
  }

  if (!(await queries.roomExists(c.env.DB, roomId))) {
    return Errors.notFound("Room not found").toResponse();
  }

  const event = await queries.findClosestEventByTimestamp(c.env.DB, roomId, ts, dir);
  if (!event) {
    return Errors.notFound("No event found near timestamp").toResponse();
  }

  return c.json(event);
});

export default app;
