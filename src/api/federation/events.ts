import { Hono } from "hono";
import type { AppEnv, EventId } from "../../types";
import { Errors } from "../../utils/errors";
import { toEventId, toRoomId } from "../../utils/ids";
import { EventQueryService } from "../../matrix/application/event-query-service";
import { getPartialStateJoinForRoom } from "../../matrix/application/features/partial-state/tracker";
import { fetchFederationBackfill } from "../../matrix/application/features/federation/backfill";
import { fetchFederationEventAuth } from "../../matrix/application/features/federation/event-auth-fetch";
import { fetchFederationEventById } from "../../matrix/application/features/federation/event-fetch";
import { fetchFederationMissingEvents } from "../../matrix/application/features/federation/missing-events";
import { fetchFederationState } from "../../matrix/application/features/federation/state-fetch";
import { fetchFederationStateIds } from "../../matrix/application/features/federation/state-ids-fetch";
import {
  logFederationRouteWarning,
} from "./shared";
import { getFederationRoomRecord } from "../../matrix/repositories/federation-events-repository";

const app = new Hono<AppEnv>();
const queries = new EventQueryService();

app.get("/_matrix/federation/v1/event/:eventId", async (c) => {
  const response = await fetchFederationEventById(c.env, c.req.param("eventId"));
  if (!response) {
    return Errors.notFound("Event not found").toResponse();
  }
  return c.json(response);
});

app.get("/_matrix/federation/v1/state/:roomId", async (c) => {
  const roomId = toRoomId(c.req.param("roomId"));
  if (!roomId) {
    return Errors.invalidParam("roomId", "Invalid room ID").toResponse();
  }
  void c.req.query("event_id");

  return c.json(await fetchFederationState(c.env, roomId));
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

  const response = await fetchFederationStateIds(c.env, roomId);
  if (!response) {
    return Errors.notFound("Room not found").toResponse();
  }
  return c.json(response);
});

app.get("/_matrix/federation/v1/event_auth/:roomId/:eventId", async (c) => {
  const roomId = toRoomId(c.req.param("roomId"));
  const eventId = toEventId(c.req.param("eventId"));
  if (!roomId || !eventId) {
    return Errors.invalidParam("roomId", "Invalid room or event ID").toResponse();
  }

  const response = await fetchFederationEventAuth({
    env: c.env,
    roomId,
    eventId,
  });
  if (!response) {
    return Errors.notFound("Room not found").toResponse();
  }

  await logFederationRouteWarning(c, "event_auth", {
    roomId,
    eventId,
    requestedAuthEvents: response.requestedAuthEvents,
    returnedAuthChain: response.returnedAuthChain,
    missingAuthEvents: response.missingAuthEvents,
  });

  return c.json({ auth_chain: response.authChain });
});

app.get("/_matrix/federation/v1/backfill/:roomId", async (c) => {
  const roomId = toRoomId(c.req.param("roomId"));
  if (!roomId) {
    return Errors.invalidParam("roomId", "Invalid room ID").toResponse();
  }
  const limit = Math.min(Number.parseInt(c.req.query("limit") ?? "100", 10), 1000);
  const vParam = c.req.query("v");

  const room = await getFederationRoomRecord(c.env.DB, roomId);
  if (!room) {
    return Errors.notFound("Room not found").toResponse();
  }

  const startEventIds = vParam
    ? vParam
        .split(",")
        .map((value) => toEventId(value))
        .filter((value): value is EventId => value !== null)
    : [];
  return c.json(
    await fetchFederationBackfill({
      env: c.env,
      roomId,
      limit,
      startEventIds,
    }),
  );
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

  const events = await fetchFederationMissingEvents({
    env: c.env,
    roomId,
    earliestEvents: (body.earliest_events ?? [])
      .map((value) => toEventId(value))
      .filter((value): value is EventId => value !== null),
    latestEvents: (body.latest_events ?? [])
      .map((value) => toEventId(value))
      .filter((value): value is EventId => value !== null),
    limit: Math.min(body.limit ?? 10, 100),
    minDepth: body.min_depth ?? 0,
    requestingServer: origin,
  });
  if (!events) {
    return Errors.notFound("Room not found").toResponse();
  }

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
