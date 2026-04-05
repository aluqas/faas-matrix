import { Hono } from "hono";
import type { AppEnv } from "../../types";
import type { StoredContextEvent } from "../../types/events";
import { Errors } from "../../utils/errors";
import { requireAuth } from "../../middleware/auth";
import { getEvent, getMembership, getRoomMembers, getRoomState } from "../../services/database";
import {
  getPartialStateCompletionStatus,
  getPartialStateStatus,
} from "../../matrix/application/features/partial-state/tracker";

const app = new Hono<AppEnv>();
const PARTIAL_STATE_WAIT_TIMEOUT_MS = 2000;

function formatContextEvent(event: StoredContextEvent) {
  return {
    type: event.event_type,
    state_key: event.state_key ?? undefined,
    content: JSON.parse(event.content || "{}"),
    sender: event.sender,
    origin_server_ts: event.origin_server_ts,
    event_id: event.event_id,
    room_id: event.room_id,
  };
}

async function waitForPartialStateJoinCompletion(
  cache: KVNamespace | undefined,
  userId: string,
  roomId: string,
  timeoutMs = PARTIAL_STATE_WAIT_TIMEOUT_MS,
): Promise<void> {
  if (!cache) {
    return;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [marker, completion] = await Promise.all([
      getPartialStateStatus(cache, userId, roomId),
      getPartialStateCompletionStatus(cache, userId, roomId),
    ]);
    if (!marker || marker.phase === "complete") {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, completion ? 25 : 100));
  }
}

app.get("/_matrix/client/v3/rooms/:roomId/context/:eventId", requireAuth(), async (c) => {
  const userId = c.get("userId");
  const roomId = c.req.param("roomId");
  const eventId = c.req.param("eventId");
  const limit = Math.min(Number.parseInt(c.req.query("limit") || "10", 10), 100);
  const userAgent = c.req.header("User-Agent");
  const isLikelyNSE = limit <= 5;

  console.log("[rooms/context] Request:", {
    userId,
    roomId,
    eventId,
    limit,
    userAgent: userAgent?.substring(0, 100),
    isLikelyNSE,
    timestamp: new Date().toISOString(),
  });

  const membership = await getMembership(c.env.DB, roomId, userId);
  if (!membership || membership.membership !== "join") {
    console.log("[rooms/context] DENIED - not a member:", { userId, roomId, eventId });
    return Errors.forbidden("Not a member of this room").toResponse();
  }

  const targetEvent = await getEvent(c.env.DB, eventId);
  if (!targetEvent || targetEvent.room_id !== roomId) {
    console.log("[rooms/context] Event not found:", {
      eventId,
      roomId,
      eventRoomId: targetEvent?.room_id,
    });
    return Errors.notFound("Event not found").toResponse();
  }

  console.log("[rooms/context] Found event:", {
    eventId,
    eventType: targetEvent.type,
    sender: targetEvent.sender,
    timestamp: targetEvent.origin_server_ts,
  });

  const halfLimit = Math.floor(limit / 2);
  const eventsBefore = await c.env.DB.prepare(
    `SELECT event_id, room_id, sender, event_type, state_key, content, origin_server_ts
     FROM events
     WHERE room_id = ? AND origin_server_ts < ?
     ORDER BY origin_server_ts DESC LIMIT ?`,
  )
    .bind(roomId, targetEvent.origin_server_ts, halfLimit)
    .all<StoredContextEvent>();
  const eventsAfter = await c.env.DB.prepare(
    `SELECT event_id, room_id, sender, event_type, state_key, content, origin_server_ts
     FROM events
     WHERE room_id = ? AND origin_server_ts > ?
     ORDER BY origin_server_ts ASC LIMIT ?`,
  )
    .bind(roomId, targetEvent.origin_server_ts, halfLimit)
    .all<StoredContextEvent>();
  const state = await getRoomState(c.env.DB, roomId);

  return c.json({
    event: {
      type: targetEvent.type,
      state_key: targetEvent.state_key,
      content: targetEvent.content,
      sender: targetEvent.sender,
      origin_server_ts: targetEvent.origin_server_ts,
      event_id: targetEvent.event_id,
      room_id: targetEvent.room_id,
    },
    events_before: eventsBefore.results.reverse().map(formatContextEvent),
    events_after: eventsAfter.results.map(formatContextEvent),
    state: state.map((event) => ({
      type: event.type,
      state_key: event.state_key,
      content: event.content,
      sender: event.sender,
      origin_server_ts: event.origin_server_ts,
      event_id: event.event_id,
      room_id: event.room_id,
    })),
    start:
      eventsBefore.results.length > 0
        ? String(eventsBefore.results[0].origin_server_ts)
        : undefined,
    end:
      eventsAfter.results.length > 0
        ? String(eventsAfter.results[eventsAfter.results.length - 1].origin_server_ts)
        : undefined,
  });
});

async function getJoinedMembers(c: import("hono").Context<AppEnv>): Promise<Response> {
  const userId = c.get("userId");
  const roomId = c.req.param("roomId");

  await waitForPartialStateJoinCompletion(c.env.CACHE, userId, roomId);

  const membership = await getMembership(c.env.DB, roomId, userId);
  if (!membership || membership.membership !== "join") {
    return Errors.forbidden("Not a member of this room").toResponse();
  }

  const joined: Record<string, { display_name: string | null; avatar_url: string | null }> = {};
  for (const member of await getRoomMembers(c.env.DB, roomId, "join")) {
    joined[member.userId] = {
      display_name: member.displayName ?? null,
      avatar_url: member.avatarUrl ?? null,
    };
  }

  return c.json({ joined });
}

app.get("/_matrix/client/v3/rooms/:roomId/joined_members", requireAuth(), (c) =>
  getJoinedMembers(c),
);
app.get("/_matrix/client/r0/rooms/:roomId/joined_members", requireAuth(), (c) =>
  getJoinedMembers(c),
);

export default app;
