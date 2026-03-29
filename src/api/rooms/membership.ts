import { Hono } from "hono";
import type { AppEnv, PDU, RoomMemberContent } from "../../types";
import { Errors } from "../../utils/errors";
import { requireAuth } from "../../middleware/auth";
import { generateEventId } from "../../utils/ids";
import { federationGet, federationPut } from "../../services/federation-keys";
import {
  applyMembershipTransitionToDatabase,
  loadMembershipTransitionContext,
} from "../../matrix/application/member-transition-service";
import { getServerFromRoomId } from "../../matrix/application/rooms-support";
import { fanoutEventToRemoteServers } from "../../services/federation-fanout";
import {
  getMembership,
  getRoom,
  getRoomByAlias,
  getRoomEvents,
  notifyUsersOfEvent,
  getStateEvent,
  storeEvent,
} from "../../services/database";

const app = new Hono<AppEnv>();

async function handleKnock(
  c: import("hono").Context<AppEnv>,
  roomId: string,
  reason?: string,
  serverNames?: string[],
) {
  const userId = c.get("userId");
  const db = c.env.DB;

  const currentMembership = await getMembership(db, roomId, userId);
  if (currentMembership?.membership === "join") {
    return Errors.forbidden("User is already joined to this room").toResponse();
  }
  if (currentMembership?.membership === "invite") {
    return Errors.forbidden("User is already invited to this room").toResponse();
  }
  if (currentMembership?.membership === "ban") {
    return Errors.forbidden("User is banned from this room").toResponse();
  }

  const room = await getRoom(db, roomId);
  const remoteServer = serverNames?.[0] || getServerFromRoomId(roomId);
  const roomCreateEvent = room ? await getStateEvent(db, roomId, "m.room.create") : null;
  const isRemoteStubRoom = Boolean(
    room && remoteServer && remoteServer !== c.env.SERVER_NAME && !roomCreateEvent,
  );

  if (!room || isRemoteStubRoom) {
    if (!remoteServer || remoteServer === c.env.SERVER_NAME) {
      return Errors.notFound("Room not found").toResponse();
    }

    const makeKnockResponse = await federationGet(
      remoteServer,
      `/_matrix/federation/v1/make_knock/${encodeURIComponent(roomId)}/${encodeURIComponent(userId)}`,
      c.env.SERVER_NAME,
      db,
      c.env.CACHE,
    );
    if (!makeKnockResponse.ok) {
      if (makeKnockResponse.status === 403) {
        return Errors.forbidden("Room does not allow knocking").toResponse();
      }
      if (makeKnockResponse.status === 404) {
        return Errors.notFound("Room not found").toResponse();
      }
      return Errors.unknown(`make_knock failed: ${makeKnockResponse.status}`).toResponse();
    }

    const makeKnock = (await makeKnockResponse.json()) as {
      room_version?: string;
      event?: { depth?: number; auth_events?: string[]; prev_events?: string[] };
    };
    if (!makeKnock.event) {
      return Errors.unknown("Remote server did not return a knock template").toResponse();
    }

    const eventId = await generateEventId(c.env.SERVER_NAME);
    const event: PDU = {
      event_id: eventId,
      room_id: roomId,
      sender: userId,
      type: "m.room.member",
      state_key: userId,
      content: {
        membership: "knock",
        ...(reason !== undefined ? { reason } : {}),
      },
      origin_server_ts: Date.now(),
      depth: makeKnock.event.depth ?? 1,
      auth_events: makeKnock.event.auth_events ?? [],
      prev_events: makeKnock.event.prev_events ?? [],
    };

    const sendKnockResponse = await federationPut(
      remoteServer,
      `/_matrix/federation/v1/send_knock/${encodeURIComponent(roomId)}/${encodeURIComponent(eventId)}`,
      event,
      c.env.SERVER_NAME,
      db,
      c.env.CACHE,
    );
    if (!sendKnockResponse.ok) {
      return Errors.unknown(`send_knock failed: ${sendKnockResponse.status}`).toResponse();
    }

    const sendKnock = (await sendKnockResponse.json()) as {
      knock_room_state?: Array<{
        type?: string;
        state_key?: string;
        content?: Record<string, unknown>;
        sender?: string;
      }>;
    };

    await db
      .prepare(`
      INSERT OR IGNORE INTO rooms (room_id, room_version, creator_id, is_public)
      VALUES (?, ?, '', 0)
    `)
      .bind(roomId, makeKnock.room_version || "10")
      .run();

    const transitionContext = await loadMembershipTransitionContext(db, roomId, userId);
    await storeEvent(db, event);
    await applyMembershipTransitionToDatabase(db, {
      roomId,
      event,
      source: "client",
      context: transitionContext,
    });
    await notifyUsersOfEvent(c.env, roomId, eventId, "m.room.member");

    for (const stripped of sendKnock.knock_room_state || []) {
      if (!stripped.type || !stripped.sender) {
        continue;
      }
      await db
        .prepare(`
        INSERT OR REPLACE INTO invite_stripped_state (room_id, event_type, state_key, content, sender)
        VALUES (?, ?, ?, ?, ?)
      `)
        .bind(
          roomId,
          stripped.type,
          stripped.state_key ?? "",
          JSON.stringify(stripped.content ?? {}),
          stripped.sender,
        )
        .run();
    }

    return c.json({ room_id: roomId });
  }

  const joinRulesEvent = await getStateEvent(db, roomId, "m.room.join_rules");
  const joinRule =
    (joinRulesEvent?.content as { join_rule?: string } | null)?.join_rule || "invite";
  if (!["knock", "knock_restricted"].includes(joinRule)) {
    return Errors.forbidden("Room does not allow knocking").toResponse();
  }

  const eventId = await generateEventId(c.env.SERVER_NAME);
  const createEvent = await getStateEvent(db, roomId, "m.room.create");
  const powerLevelsEvent = await getStateEvent(db, roomId, "m.room.power_levels");

  const authEvents: string[] = [];
  if (createEvent) authEvents.push(createEvent.event_id);
  if (joinRulesEvent) authEvents.push(joinRulesEvent.event_id);
  if (powerLevelsEvent) authEvents.push(powerLevelsEvent.event_id);
  if (currentMembership) authEvents.push(currentMembership.eventId);

  const { events: latestEvents } = await getRoomEvents(db, roomId, undefined, 1);
  const prevEvents = latestEvents.map((event) => event.event_id);

  const memberContent: RoomMemberContent = {
    membership: "knock",
    reason,
  };

  const event: PDU = {
    event_id: eventId,
    room_id: roomId,
    sender: userId,
    type: "m.room.member",
    state_key: userId,
    content: memberContent,
    origin_server_ts: Date.now(),
    depth: (latestEvents[0]?.depth ?? 0) + 1,
    auth_events: authEvents,
    prev_events: prevEvents,
  };

  const transitionContext = await loadMembershipTransitionContext(db, roomId, userId);
  await storeEvent(db, event);
  await applyMembershipTransitionToDatabase(db, {
    roomId,
    event,
    source: "client",
    context: transitionContext,
  });
  await notifyUsersOfEvent(c.env, roomId, eventId, "m.room.member");
  c.executionCtx.waitUntil(
    fanoutEventToRemoteServers(db, c.env.CACHE, c.env.SERVER_NAME, roomId, event).catch((error) => {
      console.error("[rooms/membership.knock] Failed to fan out knock event:", error);
    }),
  );

  return c.json({ room_id: roomId });
}

app.post("/_matrix/client/v3/rooms/:roomId/knock", requireAuth(), async (c) => {
  let body: { reason?: string };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }

  return handleKnock(c, c.req.param("roomId"), body.reason);
});

app.post("/_matrix/client/v3/knock/:roomIdOrAlias", requireAuth(), async (c) => {
  let body: { reason?: string; server_name?: string[] };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }

  let roomId = c.req.param("roomIdOrAlias");
  if (roomId.startsWith("#")) {
    const resolved = await getRoomByAlias(c.env.DB, roomId);
    if (!resolved) {
      return Errors.notFound("Room alias not found").toResponse();
    }
    roomId = resolved;
  }

  return handleKnock(c, roomId, body.reason, body.server_name);
});

export default app;
