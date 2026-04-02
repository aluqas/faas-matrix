import { Hono } from "hono";
import type { AppEnv, PDU, RoomCreateContent } from "../../types";
import { ErrorCodes } from "../../types";
import { Errors, MatrixApiError } from "../../utils/errors";
import { requireAuth } from "../../middleware/auth";
import { generateEventId, generateRoomId } from "../../utils/ids";
import {
  createRoom,
  getMembership,
  getRoom,
  getRoomState,
  getStateEvent,
  getUserRooms,
  storeEvent,
  updateMembership,
} from "../../services/database";
import { FORGOTTEN_ROOM_ACCOUNT_DATA_TYPE } from "../../matrix/application/room-account-data";
import { toRouteErrorResponse } from "./shared";

const app = new Hono<AppEnv>();

const SUPPORTED_ROOM_VERSIONS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"];

app.post("/_matrix/client/v3/createRoom", requireAuth(), async (c) => {
  try {
    const body = await c.req.json();
    const response = await c.get("appContext").services.rooms.createRoom({
      userId: c.get("userId"),
      body,
    });
    return c.json(response);
  } catch (error) {
    const response = toRouteErrorResponse(error);
    if (response) {
      return response;
    }
    throw error;
  }
});

app.get("/_matrix/client/v3/joined_rooms", requireAuth(), async (c) => {
  const rooms = await getUserRooms(c.env.DB, c.get("userId"), "join");
  return c.json({ joined_rooms: rooms });
});

app.post("/_matrix/client/v3/rooms/:roomId/forget", requireAuth(), async (c) => {
  const userId = c.get("userId");
  const roomId = c.req.param("roomId");
  const membership = await getMembership(c.env.DB, roomId, userId);

  if (membership && membership.membership === "join") {
    return new MatrixApiError(
      ErrorCodes.M_UNKNOWN,
      "Cannot forget room while still a member",
      400,
    ).toResponse();
  }

  await c.env.DB.prepare(
    `INSERT INTO account_data (user_id, room_id, event_type, content, deleted)
     VALUES (?, ?, ?, ?, 0)
     ON CONFLICT (user_id, room_id, event_type) DO UPDATE SET
       content = excluded.content,
       deleted = 0`,
  )
    .bind(
      userId,
      roomId,
      FORGOTTEN_ROOM_ACCOUNT_DATA_TYPE,
      JSON.stringify({ forgotten: true, forgotten_at: Date.now() }),
    )
    .run();

  await c.env.DB.prepare(`DELETE FROM room_memberships WHERE room_id = ? AND user_id = ?`)
    .bind(roomId, userId)
    .run();

  return c.json({});
});

app.post("/_matrix/client/v3/rooms/:roomId/upgrade", requireAuth(), async (c) => {
  const userId = c.get("userId");
  const oldRoomId = c.req.param("roomId");
  const db = c.env.DB;
  const serverName = c.env.SERVER_NAME;

  let body: { new_version: string };
  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  if (!body.new_version) {
    return Errors.missingParam("new_version").toResponse();
  }

  if (!SUPPORTED_ROOM_VERSIONS.includes(body.new_version)) {
    return c.json(
      {
        errcode: "M_UNSUPPORTED_ROOM_VERSION",
        error: `Room version ${body.new_version} is not supported`,
      },
      400,
    );
  }

  const oldRoom = await getRoom(db, oldRoomId);
  if (!oldRoom) {
    return Errors.notFound("Room not found").toResponse();
  }

  const membership = await getMembership(db, oldRoomId, userId);
  if (!membership || membership.membership !== "join") {
    return Errors.forbidden("Not a member of this room").toResponse();
  }

  const powerLevelsEvent = await getStateEvent(db, oldRoomId, "m.room.power_levels", "");
  const powerLevels = powerLevelsEvent
    ? JSON.parse(
        typeof powerLevelsEvent.content === "string"
          ? powerLevelsEvent.content
          : JSON.stringify(powerLevelsEvent.content),
      )
    : null;

  const userPowerLevel = powerLevels?.users?.[userId] ?? powerLevels?.users_default ?? 0;
  const tombstonePowerLevel =
    powerLevels?.events?.["m.room.tombstone"] ?? powerLevels?.state_default ?? 50;

  if (userPowerLevel < tombstonePowerLevel) {
    return Errors.forbidden("Insufficient power level to upgrade room").toResponse();
  }

  const currentState = await getRoomState(db, oldRoomId);
  const now = Date.now();
  const newRoomId = await generateRoomId(serverName);
  const lastEvent = await db
    .prepare(`SELECT event_id FROM events WHERE room_id = ? ORDER BY depth DESC LIMIT 1`)
    .bind(oldRoomId)
    .first<{ event_id: string }>();

  await createRoom(db, newRoomId, body.new_version, userId, false);

  let depth = 0;
  const authEvents: string[] = [];
  const prevEvents: string[] = [];

  async function createNewRoomEvent(
    type: string,
    content: Record<string, unknown> | RoomCreateContent,
    stateKey?: string,
  ): Promise<string> {
    const eventId = await generateEventId(serverName);
    const event: PDU = {
      event_id: eventId,
      room_id: newRoomId,
      sender: userId,
      type,
      state_key: stateKey,
      content: content as Record<string, unknown>,
      origin_server_ts: now + depth,
      depth: depth++,
      auth_events: [...authEvents],
      prev_events: [...prevEvents],
    };

    await storeEvent(db, event);

    if (stateKey !== undefined) {
      authEvents.push(eventId);
    }
    prevEvents.length = 0;
    prevEvents.push(eventId);
    return eventId;
  }

  const createContent: RoomCreateContent = {
    creator: userId,
    room_version: body.new_version,
    predecessor: {
      room_id: oldRoomId,
      event_id: lastEvent?.event_id || "",
    },
  };
  await createNewRoomEvent("m.room.create", createContent, "");

  const joinEventId = await createNewRoomEvent("m.room.member", { membership: "join" }, userId);
  await updateMembership(db, newRoomId, userId, "join", joinEventId);

  if (powerLevels) {
    await createNewRoomEvent("m.room.power_levels", powerLevels, "");
  } else {
    await createNewRoomEvent(
      "m.room.power_levels",
      {
        users: { [userId]: 100 },
        users_default: 0,
        events_default: 0,
        state_default: 50,
        ban: 50,
        kick: 50,
        redact: 50,
        invite: 0,
      },
      "",
    );
  }

  const joinRulesEvent = currentState.find((event) => event.type === "m.room.join_rules");
  if (joinRulesEvent) {
    const content =
      typeof joinRulesEvent.content === "string"
        ? JSON.parse(joinRulesEvent.content)
        : joinRulesEvent.content;
    await createNewRoomEvent("m.room.join_rules", content, "");
  } else {
    await createNewRoomEvent("m.room.join_rules", { join_rule: "invite" }, "");
  }

  const historyEvent = currentState.find((event) => event.type === "m.room.history_visibility");
  if (historyEvent) {
    const content =
      typeof historyEvent.content === "string"
        ? JSON.parse(historyEvent.content)
        : historyEvent.content;
    await createNewRoomEvent("m.room.history_visibility", content, "");
  } else {
    await createNewRoomEvent("m.room.history_visibility", { history_visibility: "shared" }, "");
  }

  const copiedStateTypes = [
    "m.room.name",
    "m.room.topic",
    "m.room.avatar",
    "m.room.encryption",
    "m.room.guest_access",
  ] as const;
  for (const stateType of copiedStateTypes) {
    const sourceEvent = currentState.find((event) => event.type === stateType);
    if (!sourceEvent) {
      continue;
    }

    const content =
      typeof sourceEvent.content === "string"
        ? JSON.parse(sourceEvent.content)
        : sourceEvent.content;
    await createNewRoomEvent(stateType, content, "");
  }

  const oldPrevEvent = await db
    .prepare(`SELECT event_id, depth FROM events WHERE room_id = ? ORDER BY depth DESC LIMIT 1`)
    .bind(oldRoomId)
    .first<{ event_id: string; depth: number }>();
  const oldAuthEvents = currentState
    .filter((event) =>
      ["m.room.create", "m.room.power_levels", "m.room.member"].includes(event.type),
    )
    .filter((event) => event.state_key === "" || event.state_key === userId)
    .map((event) => event.event_id);

  const tombstoneEventId = await generateEventId(serverName);
  await storeEvent(db, {
    event_id: tombstoneEventId,
    room_id: oldRoomId,
    sender: userId,
    type: "m.room.tombstone",
    state_key: "",
    content: {
      body: "This room has been replaced",
      replacement_room: newRoomId,
    },
    origin_server_ts: now,
    depth: (oldPrevEvent?.depth || 0) + 1,
    auth_events: oldAuthEvents,
    prev_events: oldPrevEvent ? [oldPrevEvent.event_id] : [],
  });

  const newPowerLevels = powerLevels
    ? { ...powerLevels }
    : {
        users: { [userId]: 100 },
        users_default: 0,
        events_default: 100,
        state_default: 100,
        ban: 100,
        kick: 100,
        redact: 100,
        invite: 100,
      };
  newPowerLevels.events_default = 100;
  newPowerLevels.invite = 100;

  const restrictEventId = await generateEventId(serverName);
  await storeEvent(db, {
    event_id: restrictEventId,
    room_id: oldRoomId,
    sender: userId,
    type: "m.room.power_levels",
    state_key: "",
    content: newPowerLevels,
    origin_server_ts: now + 1,
    depth: (oldPrevEvent?.depth || 0) + 2,
    auth_events: oldAuthEvents,
    prev_events: [tombstoneEventId],
  });

  const aliases = await db
    .prepare(`SELECT alias FROM room_aliases WHERE room_id = ?`)
    .bind(oldRoomId)
    .all<{ alias: string }>();
  for (const aliasRow of aliases.results) {
    await db
      .prepare(`UPDATE room_aliases SET room_id = ? WHERE alias = ?`)
      .bind(newRoomId, aliasRow.alias)
      .run();
  }

  return c.json({ replacement_room: newRoomId });
});

export default app;
