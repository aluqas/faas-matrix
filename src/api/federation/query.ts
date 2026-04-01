import { Hono } from "hono";
import type { AppEnv } from "../../types";
import { Errors } from "../../utils/errors";
import { EventQueryService } from "../../matrix/application/event-query-service";

const app = new Hono<AppEnv>();
const queries = new EventQueryService();

app.post("/_matrix/federation/v1/get_missing_events/:roomId", async (c) => {
  const roomId = c.req.param("roomId");
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
    earliestEvents: body.earliest_events || [],
    latestEvents: body.latest_events || [],
    limit: Math.min(body.limit || 10, 100),
    minDepth: body.min_depth || 0,
    roomVersion: room.room_version,
    requestingServer: origin,
  });

  return c.json({ events });
});

app.get("/_matrix/federation/v1/timestamp_to_event/:roomId", async (c) => {
  const roomId = c.req.param("roomId");
  const ts = Number.parseInt(c.req.query("ts") || "0", 10);
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
