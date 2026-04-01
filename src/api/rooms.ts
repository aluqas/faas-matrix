// Matrix room endpoints

import { Hono } from "hono";
import type { AppEnv, RoomCreateContent, PDU } from "../types";
import { ErrorCodes } from "../types";
import { Errors, MatrixApiError } from "../utils/errors";
import { requireAuth } from "../middleware/auth";
import { generateRoomId, generateEventId, parseRoomAlias } from "../utils/ids";
import { invalidateRoomCache } from "../services/room-cache";
import { federationGet } from "../services/federation-keys";
import {
  createRoom,
  getRoom,
  storeEvent,
  getRoomState,
  getStateEvent,
  getRoomEvents,
  updateMembership,
  getMembership,
  getUserRooms,
  getRoomMembers,
  createRoomAlias,
  getRoomByAlias,
  deleteRoomAlias,
  getEvent,
  notifyUsersOfEvent,
} from "../services/database";
import { getPartialStateJoin } from "../matrix/application/features/partial-state/tracker";
import { FORGOTTEN_ROOM_ACCOUNT_DATA_TYPE } from "../matrix/application/room-account-data";
import { EventQueryService } from "../matrix/application/event-query-service";
import roomMembershipRoutes from "./rooms/membership";
import roomQueryRoutes from "./rooms/query";
const app = new Hono<AppEnv>();
const eventQueries = new EventQueryService();

app.route("/", roomMembershipRoutes);
app.route("/", roomQueryRoutes);

async function resolveRoomIdOrAlias(
  c: import("hono").Context<AppEnv>,
  roomIdOrAlias: string,
  serverHints: string[],
): Promise<{ roomId: string; remoteServers: string[] }> {
  if (!roomIdOrAlias.startsWith("#")) {
    return { roomId: roomIdOrAlias, remoteServers: serverHints };
  }

  const localRoomId = await getRoomByAlias(c.env.DB, roomIdOrAlias);
  if (localRoomId) {
    return { roomId: localRoomId, remoteServers: serverHints };
  }

  const parsedAlias = parseRoomAlias(roomIdOrAlias);
  if (!parsedAlias) {
    throw Errors.notFound("Room alias not found");
  }

  const candidateServers = Array.from(new Set([parsedAlias.serverName, ...serverHints]));
  for (const serverName of candidateServers) {
    const response = await federationGet(
      serverName,
      `/_matrix/federation/v1/query/directory?room_alias=${encodeURIComponent(roomIdOrAlias)}`,
      c.env.SERVER_NAME,
      c.env.DB,
      c.env.CACHE,
    ).catch(() => null);

    if (!response?.ok) {
      continue;
    }

    const body = (await response.json()) as {
      room_id?: unknown;
      servers?: unknown;
    };
    if (typeof body.room_id !== "string") {
      continue;
    }

    const responseServers = Array.isArray(body.servers)
      ? body.servers.filter((value): value is string => typeof value === "string")
      : [];
    return {
      roomId: body.room_id,
      remoteServers: Array.from(new Set([...candidateServers, ...responseServers])),
    };
  }

  throw Errors.notFound("Room alias not found");
}

function parseMessagesRelationFilter(rawFilter: string | undefined): {
  relTypes?: string[];
  notRelTypes?: string[];
} | null {
  if (!rawFilter) {
    return {};
  }

  const parsed = JSON.parse(rawFilter) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  const record = parsed as Record<string, unknown>;
  const relTypes = Array.isArray(record["org.matrix.msc3874.rel_types"])
    ? record["org.matrix.msc3874.rel_types"].filter(
        (value): value is string => typeof value === "string",
      )
    : undefined;
  const notRelTypes = Array.isArray(record["org.matrix.msc3874.not_rel_types"])
    ? record["org.matrix.msc3874.not_rel_types"].filter(
        (value): value is string => typeof value === "string",
      )
    : undefined;

  return {
    ...(relTypes && relTypes.length > 0 ? { relTypes } : {}),
    ...(notRelTypes && notRelTypes.length > 0 ? { notRelTypes } : {}),
  };
}

async function waitForPartialStateJoinCompletion(
  cache: KVNamespace | undefined,
  userId: string,
  roomId: string,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const marker = await getPartialStateJoin(cache, userId, roomId);
    if (!marker) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function parseOptionalJsonObjectBody(
  c: import("hono").Context<AppEnv>,
): Promise<Record<string, unknown> | undefined> {
  const bodyText = await c.req.text();
  if (bodyText.trim().length === 0) {
    return undefined;
  }

  const parsed = JSON.parse(bodyText);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw Errors.badJson();
  }

  return parsed as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function badAlias(message: string = "Room alias does not point to this room"): MatrixApiError {
  return new MatrixApiError(ErrorCodes.M_BAD_ALIAS, message, 400);
}

async function validateCanonicalAliasReference(
  db: D1Database,
  roomId: string,
  alias: string,
): Promise<MatrixApiError | null> {
  if (!parseRoomAlias(alias)) {
    return Errors.invalidParam("alias", "Invalid room alias format");
  }

  const mappedRoomId = await getRoomByAlias(db, alias);
  if (!mappedRoomId || mappedRoomId !== roomId) {
    return badAlias();
  }

  return null;
}

async function validateCanonicalAliasContent(
  db: D1Database,
  roomId: string,
  content: unknown,
): Promise<MatrixApiError | null> {
  if (!isRecord(content)) {
    return Errors.badJson();
  }

  const alias = content["alias"];
  if (alias !== undefined) {
    if (typeof alias !== "string") {
      return Errors.invalidParam("alias", "alias must be a string");
    }
    const aliasError = await validateCanonicalAliasReference(db, roomId, alias);
    if (aliasError) {
      return aliasError;
    }
  }

  const altAliases = content["alt_aliases"];
  if (altAliases !== undefined) {
    if (!Array.isArray(altAliases) || altAliases.some((entry) => typeof entry !== "string")) {
      return Errors.invalidParam("alt_aliases", "alt_aliases must be an array of room aliases");
    }

    for (const altAlias of altAliases) {
      const aliasError = await validateCanonicalAliasReference(db, roomId, altAlias);
      if (aliasError) {
        return aliasError;
      }
    }
  }

  return null;
}

function getUserPowerLevelFromContent(
  content: unknown,
  userId: string,
): { userPower: number; stateDefault: number; eventLevels: Record<string, number> } {
  if (!isRecord(content)) {
    return { userPower: 0, stateDefault: 50, eventLevels: {} };
  }

  const users = isRecord(content["users"]) ? content["users"] : {};
  const events = isRecord(content["events"]) ? content["events"] : {};
  const usersDefault = typeof content["users_default"] === "number" ? content["users_default"] : 0;
  const stateDefault = typeof content["state_default"] === "number" ? content["state_default"] : 50;
  const explicitUserPower = users[userId];
  const userPower = typeof explicitUserPower === "number" ? explicitUserPower : usersDefault;

  return {
    userPower,
    stateDefault,
    eventLevels: Object.fromEntries(
      Object.entries(events).filter(([, value]) => typeof value === "number"),
    ) as Record<string, number>,
  };
}

async function canUserSendStateEvent(
  db: D1Database,
  roomId: string,
  userId: string,
  eventType: string,
): Promise<boolean> {
  const membership = await getMembership(db, roomId, userId);
  if (!membership || membership.membership !== "join") {
    return false;
  }

  const powerLevelsEvent = await getStateEvent(db, roomId, "m.room.power_levels", "");
  const { userPower, stateDefault, eventLevels } = getUserPowerLevelFromContent(
    powerLevelsEvent?.content,
    userId,
  );
  const requiredPower =
    typeof eventLevels[eventType] === "number" ? eventLevels[eventType] : stateDefault;

  return userPower >= requiredPower;
}

function removeDeletedAliasFromCanonicalContent(
  content: unknown,
  deletedAlias: string,
): Record<string, unknown> | null {
  if (!isRecord(content)) {
    return null;
  }

  const nextContent: Record<string, unknown> = { ...content };
  let changed = false;

  if (nextContent["alias"] === deletedAlias) {
    delete nextContent["alias"];
    changed = true;
  }

  const altAliases = nextContent["alt_aliases"];
  if (Array.isArray(altAliases)) {
    const remaining = altAliases.filter((entry): entry is string => typeof entry === "string");
    const filtered = remaining.filter((entry) => entry !== deletedAlias);
    if (filtered.length !== remaining.length) {
      changed = true;
      if (filtered.length > 0) {
        nextContent["alt_aliases"] = filtered;
      } else {
        delete nextContent["alt_aliases"];
      }
    }
  }

  return changed ? nextContent : null;
}

// POST /_matrix/client/v3/createRoom - Create a new room
app.post("/_matrix/client/v3/createRoom", requireAuth(), async (c) => {
  try {
    const body = await c.req.json();
    const response = await c.get("appContext").services.rooms.createRoom({
      userId: c.get("userId"),
      body,
    });
    return c.json(response);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return Errors.badJson().toResponse();
    }
    if (error instanceof Error && "toResponse" in error) {
      return (error as { toResponse(): Response }).toResponse();
    }
    throw error;
  }
});

// GET /_matrix/client/v3/joined_rooms - List joined rooms
app.get("/_matrix/client/v3/joined_rooms", requireAuth(), async (c) => {
  const userId = c.get("userId");
  const rooms = await getUserRooms(c.env.DB, userId, "join");
  return c.json({ joined_rooms: rooms });
});

// POST /_matrix/client/v3/rooms/:roomId/join - Join a room
app.post("/_matrix/client/v3/rooms/:roomId/join", requireAuth(), async (c) => {
  try {
    const body = await parseOptionalJsonObjectBody(c);
    const response = await c.get("appContext").services.rooms.joinRoom({
      userId: c.get("userId"),
      roomId: c.req.param("roomId"),
      ...(body !== undefined ? { body } : {}),
    });
    return c.json(response);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return Errors.badJson().toResponse();
    }
    if (error instanceof Error && "toResponse" in error) {
      return (error as { toResponse(): Response }).toResponse();
    }
    throw error;
  }
});

// POST /_matrix/client/v3/rooms/:roomId/leave - Leave a room
app.post("/_matrix/client/v3/rooms/:roomId/leave", requireAuth(), async (c) => {
  try {
    await c.get("appContext").services.rooms.leaveRoom({
      userId: c.get("userId"),
      roomId: c.req.param("roomId"),
    });
    return c.json({});
  } catch (error) {
    if (error instanceof Error && "toResponse" in error) {
      return (error as { toResponse(): Response }).toResponse();
    }
    throw error;
  }
});

// GET /_matrix/client/v3/rooms/:roomId/state - Get all current state
app.get("/_matrix/client/v3/rooms/:roomId/state", requireAuth(), async (c) => {
  const userId = c.get("userId");
  const roomId = c.req.param("roomId");

  // Check membership
  const membership = await getMembership(c.env.DB, roomId, userId);
  if (!membership || membership.membership !== "join") {
    return Errors.forbidden("Not a member of this room").toResponse();
  }

  const state = await getRoomState(c.env.DB, roomId);

  // Format events for client
  const clientEvents = state.map((e) => ({
    type: e.type,
    state_key: e.state_key,
    content: e.content,
    sender: e.sender,
    origin_server_ts: e.origin_server_ts,
    event_id: e.event_id,
    room_id: e.room_id,
  }));

  return c.json(clientEvents);
});

async function getRoomStateEvent(
  c: import("hono").Context<AppEnv>,
  stateKey: string,
): Promise<Response> {
  const userId = c.get("userId");
  const roomId = c.req.param("roomId");
  const eventType = c.req.param("eventType");

  const membership = await getMembership(c.env.DB, roomId, userId);
  if (!membership || membership.membership !== "join") {
    return Errors.forbidden("Not a member of this room").toResponse();
  }

  const event = await getStateEvent(c.env.DB, roomId, eventType, stateKey);
  if (!event) {
    return Errors.notFound("State event not found").toResponse();
  }

  if (c.req.query("format") === "event") {
    return c.json({
      type: event.type,
      state_key: event.state_key,
      content: event.content,
      sender: event.sender,
      origin_server_ts: event.origin_server_ts,
      event_id: event.event_id,
      room_id: event.room_id,
    });
  }

  return c.json(event.content);
}

async function putRoomStateEvent(
  c: import("hono").Context<AppEnv>,
  stateKey: string,
): Promise<Response> {
  const userId = c.get("userId");
  const roomId = c.req.param("roomId");
  const eventType = c.req.param("eventType");

  const membership = await getMembership(c.env.DB, roomId, userId);
  if (!membership || membership.membership !== "join") {
    return Errors.forbidden("Not a member of this room").toResponse();
  }

  let content: any;
  try {
    content = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  if (eventType === "m.room.canonical_alias" && stateKey === "") {
    const validationError = await validateCanonicalAliasContent(c.env.DB, roomId, content);
    if (validationError) {
      return validationError.toResponse();
    }
  }
  const txnId = await c.get("appContext").capabilities.id.generateOpaqueId();
  const response = await c.get("appContext").services.rooms.sendEvent({
    userId,
    roomId,
    eventType,
    stateKey,
    txnId,
    content,
  });

  const CACHED_STATE_TYPES = [
    "m.room.name",
    "m.room.avatar",
    "m.room.topic",
    "m.room.canonical_alias",
    "m.room.member",
  ];
  if (CACHED_STATE_TYPES.includes(eventType)) {
    invalidateRoomCache(c.env.CACHE, roomId).catch(() => {});
  }

  if (eventType === "m.room.member") {
    await updateMembership(
      c.env.DB,
      roomId,
      stateKey,
      content.membership,
      response.event_id,
      content.displayname,
      content.avatar_url,
    );
  }
  return c.json(response);
}

// GET /_matrix/client/v3/rooms/:roomId/state/:eventType/:stateKey? - Get specific state
app.get("/_matrix/client/v3/rooms/:roomId/state/:eventType/:stateKey?", requireAuth(), (c) =>
  getRoomStateEvent(c, c.req.param("stateKey") ?? ""),
);
app.get("/_matrix/client/v3/rooms/:roomId/state/:eventType/", requireAuth(), (c) =>
  getRoomStateEvent(c, ""),
);

// PUT /_matrix/client/v3/rooms/:roomId/state/:eventType/:stateKey? - Set state
app.put("/_matrix/client/v3/rooms/:roomId/state/:eventType/:stateKey?", requireAuth(), (c) =>
  putRoomStateEvent(c, c.req.param("stateKey") ?? ""),
);
app.put("/_matrix/client/v3/rooms/:roomId/state/:eventType/", requireAuth(), (c) =>
  putRoomStateEvent(c, ""),
);

// GET /_matrix/client/v3/rooms/:roomId/members - Get room members
app.get("/_matrix/client/v3/rooms/:roomId/members", requireAuth(), async (c) => {
  const userId = c.get("userId");
  const roomId = c.req.param("roomId");

  await waitForPartialStateJoinCompletion(c.env.CACHE, userId, roomId);

  // Check membership
  const membership = await getMembership(c.env.DB, roomId, userId);
  if (!membership || membership.membership !== "join") {
    return Errors.forbidden("Not a member of this room").toResponse();
  }

  const members = await getRoomMembers(c.env.DB, roomId);

  // Get full member events - OPTIMIZED: fetch in parallel instead of sequential
  const events = await Promise.all(
    members.map((member) => getStateEvent(c.env.DB, roomId, "m.room.member", member.userId)),
  );

  const memberEvents = events
    .filter((event): event is NonNullable<typeof event> => event !== null && event !== undefined)
    .map((event) => ({
      type: event.type,
      state_key: event.state_key,
      content: event.content,
      sender: event.sender,
      origin_server_ts: event.origin_server_ts,
      event_id: event.event_id,
      room_id: event.room_id,
    }));

  return c.json({ chunk: memberEvents });
});

// GET /_matrix/client/v3/rooms/:roomId/messages - Get room messages
app.get("/_matrix/client/v3/rooms/:roomId/messages", requireAuth(), async (c) => {
  const userId = c.get("userId");
  const roomId = c.req.param("roomId");

  // Check membership
  const membership = await getMembership(c.env.DB, roomId, userId);
  if (!membership || membership.membership !== "join") {
    return Errors.forbidden("Not a member of this room").toResponse();
  }

  const from = c.req.query("from");
  const dir = (c.req.query("dir") || "b") as "f" | "b";
  const limit = Math.min(parseInt(c.req.query("limit") || "10"), 100);
  let relationFilter: { relTypes?: string[]; notRelTypes?: string[] } | undefined;
  try {
    const parsedFilter = parseMessagesRelationFilter(c.req.query("filter"));
    if (parsedFilter === null) {
      return Errors.badJson().toResponse();
    }
    relationFilter = parsedFilter;
  } catch {
    return Errors.badJson().toResponse();
  }

  // Parse token - handle both 's123' format (from sliding-sync) and plain '123' format
  let fromToken: number | undefined;
  if (from) {
    const tokenStr = from.startsWith("s") ? from.slice(1) : from;
    const parsed = parseInt(tokenStr);
    fromToken = isNaN(parsed) ? undefined : parsed;
  }
  const { events, end } = await getRoomEvents(
    c.env.DB,
    roomId,
    fromToken,
    limit,
    dir,
    relationFilter,
  );

  // Format events for client
  const clientEvents = events.map((e) => ({
    type: e.type,
    state_key: e.state_key,
    content: e.content,
    sender: e.sender,
    origin_server_ts: e.origin_server_ts,
    event_id: e.event_id,
    room_id: e.room_id,
    unsigned: e.unsigned,
  }));

  // Build response - omit 'end' if no events returned (reached start/end of timeline)
  // This prevents infinite retry loops when client paginates past available events
  // Use 's' prefix for consistency with sliding-sync prev_batch tokens
  const response: { start: string; end?: string; chunk: typeof clientEvents } = {
    start: from || "s0",
    chunk: clientEvents,
  };

  // Only include 'end' if we have events to paginate from
  if (events.length > 0) {
    response.end = `s${end}`;
  }

  return c.json(response);
});

// GET /_matrix/client/v3/rooms/:roomId/event/:eventId - Get specific event
app.get("/_matrix/client/v3/rooms/:roomId/event/:eventId", requireAuth(), async (c) => {
  const userId = c.get("userId");
  const roomId = c.req.param("roomId");
  const eventId = c.req.param("eventId");

  const event = await eventQueries.getVisibleEventForUser(c.env.DB, roomId, eventId, userId);
  if (!event) {
    return Errors.notFound("Event not found").toResponse();
  }

  return c.json({
    type: event.type,
    state_key: event.state_key,
    content: event.content,
    sender: event.sender,
    origin_server_ts: event.origin_server_ts,
    event_id: event.event_id,
    room_id: event.room_id,
    unsigned: event.unsigned,
  });
});
app.get("/_matrix/client/r0/rooms/:roomId/event/:eventId", requireAuth(), async (c) => {
  const userId = c.get("userId");
  const roomId = c.req.param("roomId");
  const eventId = c.req.param("eventId");

  const event = await eventQueries.getVisibleEventForUser(c.env.DB, roomId, eventId, userId);
  if (!event) {
    return Errors.notFound("Event not found").toResponse();
  }

  return c.json({
    type: event.type,
    state_key: event.state_key,
    content: event.content,
    sender: event.sender,
    origin_server_ts: event.origin_server_ts,
    event_id: event.event_id,
    room_id: event.room_id,
    unsigned: event.unsigned,
  });
});

// PUT /_matrix/client/v3/rooms/:roomId/send/:eventType/:txnId - Send message
app.put("/_matrix/client/v3/rooms/:roomId/send/:eventType/:txnId", requireAuth(), async (c) => {
  try {
    const content = await c.req.json();
    const roomId = c.req.param("roomId");
    const response = await c.get("appContext").services.rooms.sendEvent({
      userId: c.get("userId"),
      roomId,
      eventType: c.req.param("eventType"),
      txnId: c.req.param("txnId"),
      content,
    });

    return c.json(response);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return Errors.badJson().toResponse();
    }
    if (error instanceof Error && "toResponse" in error) {
      return (error as { toResponse(): Response }).toResponse();
    }
    throw error;
  }
});

// POST /_matrix/client/v3/rooms/:roomId/invite - Invite a user
app.post("/_matrix/client/v3/rooms/:roomId/invite", requireAuth(), async (c) => {
  try {
    const body = await c.req.json();
    await c.get("appContext").services.rooms.inviteRoom({
      userId: c.get("userId"),
      roomId: c.req.param("roomId"),
      targetUserId: body.user_id,
    });
    return c.json({});
  } catch (error) {
    if (error instanceof SyntaxError) {
      return Errors.badJson().toResponse();
    }
    if (error instanceof Error && "toResponse" in error) {
      return (error as { toResponse(): Response }).toResponse();
    }
    throw error;
  }
});

// POST /_matrix/client/v3/rooms/:roomId/kick - Kick a user
app.post("/_matrix/client/v3/rooms/:roomId/kick", requireAuth(), async (c) => {
  try {
    const body = await c.req.json();
    await c.get("appContext").services.rooms.kickUser({
      userId: c.get("userId"),
      roomId: c.req.param("roomId"),
      targetUserId: body.user_id,
      reason: body.reason,
    });
    return c.json({});
  } catch (error) {
    if (error instanceof SyntaxError) {
      return Errors.badJson().toResponse();
    }
    if (error instanceof Error && "toResponse" in error) {
      return (error as { toResponse(): Response }).toResponse();
    }
    throw error;
  }
});

// POST /_matrix/client/v3/rooms/:roomId/ban - Ban a user
app.post("/_matrix/client/v3/rooms/:roomId/ban", requireAuth(), async (c) => {
  try {
    const body = await c.req.json();
    await c.get("appContext").services.rooms.banUser({
      userId: c.get("userId"),
      roomId: c.req.param("roomId"),
      targetUserId: body.user_id,
      reason: body.reason,
    });
    return c.json({});
  } catch (error) {
    if (error instanceof SyntaxError) {
      return Errors.badJson().toResponse();
    }
    if (error instanceof Error && "toResponse" in error) {
      return (error as { toResponse(): Response }).toResponse();
    }
    throw error;
  }
});

// POST /_matrix/client/v3/rooms/:roomId/unban - Unban a user
app.post("/_matrix/client/v3/rooms/:roomId/unban", requireAuth(), async (c) => {
  try {
    const body = await c.req.json();
    await c.get("appContext").services.rooms.unbanUser({
      userId: c.get("userId"),
      roomId: c.req.param("roomId"),
      targetUserId: body.user_id,
      reason: body.reason,
    });
    return c.json({});
  } catch (error) {
    if (error instanceof SyntaxError) {
      return Errors.badJson().toResponse();
    }
    if (error instanceof Error && "toResponse" in error) {
      return (error as { toResponse(): Response }).toResponse();
    }
    throw error;
  }
});

// POST /_matrix/client/v3/rooms/:roomId/forget - Forget a room
app.post("/_matrix/client/v3/rooms/:roomId/forget", requireAuth(), async (c) => {
  const userId = c.get("userId");
  const roomId = c.req.param("roomId");
  const db = c.env.DB;

  // Check that user has left the room
  const membership = await getMembership(db, roomId, userId);
  if (membership && membership.membership === "join") {
    return new MatrixApiError(
      ErrorCodes.M_UNKNOWN,
      "Cannot forget room while still a member",
      400,
    ).toResponse();
  }

  await db
    .prepare(
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

  // Remove membership record entirely
  await db
    .prepare(`
    DELETE FROM room_memberships WHERE room_id = ? AND user_id = ?
  `)
    .bind(roomId, userId)
    .run();

  return c.json({});
});

// PUT /_matrix/client/v3/rooms/:roomId/redact/:eventId/:txnId - Redact an event
app.put("/_matrix/client/v3/rooms/:roomId/redact/:eventId/:txnId", requireAuth(), async (c) => {
  const userId = c.get("userId");
  const roomId = c.req.param("roomId");
  const targetEventId = c.req.param("eventId");
  const txnId = c.req.param("txnId");

  // Check membership
  const membership = await getMembership(c.env.DB, roomId, userId);
  if (!membership || membership.membership !== "join") {
    return Errors.forbidden("Not a member of this room").toResponse();
  }

  // Get the target event
  const targetEvent = await getEvent(c.env.DB, targetEventId);
  if (!targetEvent || targetEvent.room_id !== roomId) {
    return Errors.notFound("Event not found").toResponse();
  }

  // Check power levels for redaction
  const powerLevelsEvent = await getStateEvent(c.env.DB, roomId, "m.room.power_levels");
  const powerLevels = (powerLevelsEvent?.content as any) || {};
  const userPower = powerLevels.users?.[userId] ?? powerLevels.users_default ?? 0;
  const redactPower = powerLevels.redact ?? 50;

  // Users can redact their own messages, or need redact power level
  if (targetEvent.sender !== userId && userPower < redactPower) {
    return Errors.forbidden("Insufficient power level to redact").toResponse();
  }

  let body: any = {};
  try {
    body = await c.req.json();
  } catch {
    // Body is optional for redaction
  }

  // Create redaction event
  const eventId = await generateEventId(c.env.SERVER_NAME);

  const createEvent = await getStateEvent(c.env.DB, roomId, "m.room.create");

  const authEvents: string[] = [];
  if (createEvent) authEvents.push(createEvent.event_id);
  if (powerLevelsEvent) authEvents.push(powerLevelsEvent.event_id);
  if (membership) authEvents.push(membership.eventId);

  const { events: latestEvents } = await getRoomEvents(c.env.DB, roomId, undefined, 1);
  const prevEvents = latestEvents.map((e) => e.event_id);

  const redactionContent: any = {
    redacts: targetEventId,
  };
  if (body.reason) {
    redactionContent.reason = body.reason;
  }

  const event: PDU = {
    event_id: eventId,
    room_id: roomId,
    sender: userId,
    type: "m.room.redaction",
    content: redactionContent,
    redacts: targetEventId,
    origin_server_ts: Date.now(),
    unsigned: { transaction_id: txnId },
    depth: (latestEvents[0]?.depth ?? 0) + 1,
    auth_events: authEvents,
    prev_events: prevEvents,
  };

  await storeEvent(c.env.DB, event);

  // Mark the original event as redacted
  await c.env.DB.prepare(`
    UPDATE events SET redacted_because = ? WHERE event_id = ?
  `)
    .bind(eventId, targetEventId)
    .run();

  // Notify room members about the redaction
  await notifyUsersOfEvent(c.env, roomId, eventId, "m.room.redaction");

  return c.json({ event_id: eventId });
});

// GET /_matrix/client/v3/rooms/:roomId/context/:eventId - Get context around an event
// NOTE: This endpoint is used by Element X NSE (Notification Service Extension) to fetch
// event content for rich push notifications. If you see this endpoint being called
// shortly after a push notification is sent, that's the NSE working correctly.
app.get("/_matrix/client/v3/rooms/:roomId/context/:eventId", requireAuth(), async (c) => {
  const userId = c.get("userId");
  const roomId = c.req.param("roomId");
  const eventId = c.req.param("eventId");
  const limit = Math.min(parseInt(c.req.query("limit") || "10"), 100);
  const userAgent = c.req.header("User-Agent");

  // NSE Detection logging - /context is a key endpoint for push notification content
  // NSE typically requests small limit (1-5) for single event context
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

  // Check membership
  const membership = await getMembership(c.env.DB, roomId, userId);
  if (!membership || membership.membership !== "join") {
    console.log("[rooms/context] DENIED - not a member:", { userId, roomId, eventId });
    return Errors.forbidden("Not a member of this room").toResponse();
  }

  // Get the target event
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

  // Get events before and after
  const halfLimit = Math.floor(limit / 2);

  const eventsBefore = await c.env.DB.prepare(`
    SELECT * FROM events WHERE room_id = ? AND origin_server_ts < ?
    ORDER BY origin_server_ts DESC LIMIT ?
  `)
    .bind(roomId, targetEvent.origin_server_ts, halfLimit)
    .all();

  const eventsAfter = await c.env.DB.prepare(`
    SELECT * FROM events WHERE room_id = ? AND origin_server_ts > ?
    ORDER BY origin_server_ts ASC LIMIT ?
  `)
    .bind(roomId, targetEvent.origin_server_ts, halfLimit)
    .all();

  // Format events
  const formatEvent = (e: any) => ({
    type: e.event_type,
    state_key: e.state_key,
    content: JSON.parse(e.content || "{}"),
    sender: e.sender,
    origin_server_ts: e.origin_server_ts,
    event_id: e.event_id,
    room_id: e.room_id,
  });

  // Get current state
  const state = await getRoomState(c.env.DB, roomId);
  const stateEvents = state.map((e) => ({
    type: e.type,
    state_key: e.state_key,
    content: e.content,
    sender: e.sender,
    origin_server_ts: e.origin_server_ts,
    event_id: e.event_id,
    room_id: e.room_id,
  }));

  return c.json({
    event: formatEvent(targetEvent),
    events_before: eventsBefore.results.reverse().map(formatEvent),
    events_after: eventsAfter.results.map(formatEvent),
    state: stateEvents,
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

  // Check membership
  const membership = await getMembership(c.env.DB, roomId, userId);
  if (!membership || membership.membership !== "join") {
    return Errors.forbidden("Not a member of this room").toResponse();
  }

  const members = await c.env.DB.prepare(`
    SELECT user_id, display_name, avatar_url
    FROM room_memberships
    WHERE room_id = ? AND membership = 'join'
  `)
    .bind(roomId)
    .all<{
      user_id: string;
      display_name: string | null;
      avatar_url: string | null;
    }>();

  const joined: Record<string, { display_name: string | null; avatar_url: string | null }> = {};
  for (const member of members.results) {
    joined[member.user_id] = {
      display_name: member.display_name ?? null,
      avatar_url: member.avatar_url ?? null,
    };
  }

  return c.json({ joined });
}

// GET /_matrix/client/v3/rooms/:roomId/joined_members - Get joined members with details
app.get("/_matrix/client/v3/rooms/:roomId/joined_members", requireAuth(), (c) =>
  getJoinedMembers(c),
);
app.get("/_matrix/client/r0/rooms/:roomId/joined_members", requireAuth(), (c) =>
  getJoinedMembers(c),
);

// GET /_matrix/client/v3/rooms/:roomId/aliases - Get room aliases
app.get("/_matrix/client/v3/rooms/:roomId/aliases", requireAuth(), async (c) => {
  const userId = c.get("userId");
  const roomId = c.req.param("roomId");
  const db = c.env.DB;

  // Check membership
  const membership = await getMembership(db, roomId, userId);
  if (!membership || membership.membership !== "join") {
    return Errors.forbidden("Not a member of this room").toResponse();
  }

  const aliases = await db
    .prepare(`
    SELECT alias FROM room_aliases WHERE room_id = ?
  `)
    .bind(roomId)
    .all<{ alias: string }>();

  return c.json({
    aliases: aliases.results.map((a) => a.alias),
  });
});

// POST /_matrix/client/v3/join/:roomIdOrAlias - Join room by ID or alias
app.post("/_matrix/client/v3/join/:roomIdOrAlias", requireAuth(), async (c) => {
  try {
    const roomIdOrAlias = decodeURIComponent(c.req.param("roomIdOrAlias"));
    const remoteServers = c.req.queries("server_name") ?? [];
    const body = await parseOptionalJsonObjectBody(c);
    const resolved = await resolveRoomIdOrAlias(c, roomIdOrAlias, remoteServers);

    const response = await c.get("appContext").services.rooms.joinRoom({
      userId: c.get("userId"),
      roomId: resolved.roomId,
      remoteServers: resolved.remoteServers,
      ...(body !== undefined ? { body } : {}),
    });

    return c.json(response);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return Errors.badJson().toResponse();
    }
    if (error instanceof Error && "toResponse" in error) {
      return (error as { toResponse(): Response }).toResponse();
    }
    throw error;
  }
});

// Room alias endpoints
// GET /_matrix/client/v3/directory/room/:roomAlias
app.get("/_matrix/client/v3/directory/room/:roomAlias", async (c) => {
  const alias = decodeURIComponent(c.req.param("roomAlias"));

  const roomId = await getRoomByAlias(c.env.DB, alias);
  if (roomId) {
    return c.json({
      room_id: roomId,
      servers: [c.env.SERVER_NAME],
    });
  }

  const parsedAlias = parseRoomAlias(alias);
  if (!parsedAlias || parsedAlias.serverName === c.env.SERVER_NAME) {
    return Errors.notFound("Room alias not found").toResponse();
  }

  const response = await federationGet(
    parsedAlias.serverName,
    `/_matrix/federation/v1/query/directory?room_alias=${encodeURIComponent(alias)}`,
    c.env.SERVER_NAME,
    c.env.DB,
    c.env.CACHE,
  ).catch(() => null);

  if (!response?.ok) {
    return Errors.notFound("Room alias not found").toResponse();
  }

  const body = (await response.json()) as {
    room_id?: unknown;
    servers?: unknown;
  };
  if (typeof body.room_id !== "string") {
    return Errors.notFound("Room alias not found").toResponse();
  }

  return c.json({
    room_id: body.room_id,
    servers: Array.isArray(body.servers)
      ? body.servers.filter((value): value is string => typeof value === "string")
      : [parsedAlias.serverName],
  });
});

// PUT /_matrix/client/v3/directory/room/:roomAlias
app.put("/_matrix/client/v3/directory/room/:roomAlias", requireAuth(), async (c) => {
  const userId = c.get("userId");
  const alias = decodeURIComponent(c.req.param("roomAlias"));

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  const { room_id } = body;
  if (!room_id) {
    return Errors.missingParam("room_id").toResponse();
  }

  // Check if alias already exists
  const existing = await getRoomByAlias(c.env.DB, alias);
  if (existing) {
    return Errors.roomInUse().toResponse();
  }

  // Check if user has permission (is member of room)
  const membership = await getMembership(c.env.DB, room_id, userId);
  if (!membership || membership.membership !== "join") {
    return Errors.forbidden("Not a member of this room").toResponse();
  }

  await createRoomAlias(c.env.DB, alias, room_id, userId);
  return c.json({});
});

// DELETE /_matrix/client/v3/directory/room/:roomAlias
app.delete("/_matrix/client/v3/directory/room/:roomAlias", requireAuth(), async (c) => {
  const userId = c.get("userId");
  const alias = decodeURIComponent(c.req.param("roomAlias"));

  const aliasRecord = await c.env.DB.prepare(
    `SELECT room_id, creator_id FROM room_aliases WHERE alias = ?`,
  )
    .bind(alias)
    .first<{ room_id: string; creator_id: string | null }>();

  if (!aliasRecord) {
    return Errors.notFound("Room alias not found").toResponse();
  }

  const canDeleteAsCreator = aliasRecord.creator_id === userId;
  if (!canDeleteAsCreator) {
    const powerLevelsEvent = await getStateEvent(
      c.env.DB,
      aliasRecord.room_id,
      "m.room.power_levels",
      "",
    );
    const { userPower, stateDefault } = getUserPowerLevelFromContent(
      powerLevelsEvent?.content,
      userId,
    );
    if (userPower < stateDefault) {
      return Errors.forbidden("Insufficient power level to delete alias").toResponse();
    }
  }

  await deleteRoomAlias(c.env.DB, alias);

  const canonicalAliasEvent = await getStateEvent(
    c.env.DB,
    aliasRecord.room_id,
    "m.room.canonical_alias",
    "",
  );
  const updatedCanonicalAlias = removeDeletedAliasFromCanonicalContent(
    canonicalAliasEvent?.content,
    alias,
  );

  if (
    updatedCanonicalAlias &&
    (canDeleteAsCreator
      ? await canUserSendStateEvent(c.env.DB, aliasRecord.room_id, userId, "m.room.canonical_alias")
      : true)
  ) {
    const txnId = await c.get("appContext").capabilities.id.generateOpaqueId();
    await c.get("appContext").services.rooms.sendEvent({
      userId,
      roomId: aliasRecord.room_id,
      eventType: "m.room.canonical_alias",
      stateKey: "",
      txnId,
      content: updatedCanonicalAlias,
    });
  }

  return c.json({});
});

// ============================================
// Room Summary (MSC3266)
// ============================================

// GET /_matrix/client/v1/room_summary/:roomIdOrAlias - Get a summary of a room
// Allows previewing a room without joining it (if permitted by room settings)
app.get("/_matrix/client/v1/room_summary/:roomIdOrAlias", async (c) => {
  const roomIdOrAlias = decodeURIComponent(c.req.param("roomIdOrAlias"));
  const db = c.env.DB;

  let roomId = roomIdOrAlias;

  // Resolve alias to room_id if needed
  if (roomIdOrAlias.startsWith("#")) {
    const aliasResult = await db
      .prepare(`SELECT room_id FROM room_aliases WHERE alias = ?`)
      .bind(roomIdOrAlias)
      .first<{ room_id: string }>();
    if (!aliasResult) {
      return Errors.notFound("Room alias not found").toResponse();
    }
    roomId = aliasResult.room_id;
  }

  // Get room info
  const room = await db
    .prepare(`SELECT room_id, room_version, is_public FROM rooms WHERE room_id = ?`)
    .bind(roomId)
    .first<{ room_id: string; room_version: string; is_public: number }>();

  if (!room) {
    return Errors.notFound("Room not found").toResponse();
  }

  // Get room state events we need
  const stateEvents = await db
    .prepare(`
    SELECT e.event_type, e.content FROM room_state rs
    JOIN events e ON rs.event_id = e.event_id
    WHERE rs.room_id = ? AND rs.event_type IN (
      'm.room.name', 'm.room.topic', 'm.room.avatar',
      'm.room.join_rules', 'm.room.canonical_alias', 'm.room.encryption',
      'm.room.history_visibility', 'm.room.guest_access'
    )
  `)
    .bind(roomId)
    .all<{ event_type: string; content: string }>();

  // Get member count
  const memberCount = await db
    .prepare(
      `SELECT COUNT(*) as count FROM room_memberships WHERE room_id = ? AND membership = 'join'`,
    )
    .bind(roomId)
    .first<{ count: number }>();

  // Build response
  const response: Record<string, unknown> = {
    room_id: roomId,
    num_joined_members: memberCount?.count || 0,
    room_version: room.room_version,
  };

  // Extract state
  let joinRule = "invite";
  let historyVisibility = "shared";
  let worldReadable = false;
  let guestCanJoin = false;

  for (const event of stateEvents.results || []) {
    const content = JSON.parse(event.content);
    switch (event.event_type) {
      case "m.room.name":
        response.name = content.name;
        break;
      case "m.room.topic":
        response.topic = content.topic;
        break;
      case "m.room.avatar":
        response.avatar_url = content.url;
        break;
      case "m.room.join_rules":
        joinRule = content.join_rule;
        response.join_rule = joinRule;
        break;
      case "m.room.canonical_alias":
        response.canonical_alias = content.alias;
        break;
      case "m.room.encryption":
        response.encryption = content.algorithm;
        break;
      case "m.room.history_visibility":
        historyVisibility = content.history_visibility;
        worldReadable = historyVisibility === "world_readable";
        break;
      case "m.room.guest_access":
        guestCanJoin = content.guest_access === "can_join";
        break;
    }
  }

  response.world_readable = worldReadable;
  response.guest_can_join = guestCanJoin;

  // Check user membership if authenticated (optional auth)
  const authHeader = c.req.header("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    const { hashToken } = await import("../utils/crypto");
    const tokenHash = await hashToken(token);
    const tokenResult = await db
      .prepare(`SELECT user_id FROM access_tokens WHERE token_hash = ?`)
      .bind(tokenHash)
      .first<{ user_id: string }>();

    if (tokenResult) {
      const membership = await db
        .prepare(`SELECT membership FROM room_memberships WHERE room_id = ? AND user_id = ?`)
        .bind(roomId, tokenResult.user_id)
        .first<{ membership: string }>();
      response.membership = membership?.membership || "leave";
    }
  }

  // Check if room summary is allowed based on join rules
  // For non-public rooms, only show summary if user is a member or if world_readable
  if (!room.is_public && !worldReadable && !response.membership) {
    // Don't reveal room existence for private rooms to non-members
    if (!["public", "knock", "knock_restricted"].includes(joinRule)) {
      return Errors.notFound("Room not found").toResponse();
    }
  }

  return c.json(response);
});

// ============================================
// Room Upgrade
// ============================================

// Supported room versions
const SUPPORTED_ROOM_VERSIONS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"];

// POST /_matrix/client/v3/rooms/:roomId/upgrade - Upgrade a room to a new version
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

  // Validate room version
  if (!SUPPORTED_ROOM_VERSIONS.includes(body.new_version)) {
    return c.json(
      {
        errcode: "M_UNSUPPORTED_ROOM_VERSION",
        error: `Room version ${body.new_version} is not supported`,
      },
      400,
    );
  }

  // Check if old room exists
  const oldRoom = await getRoom(db, oldRoomId);
  if (!oldRoom) {
    return Errors.notFound("Room not found").toResponse();
  }

  // Check user is a member
  const membership = await getMembership(db, oldRoomId, userId);
  if (!membership || membership.membership !== "join") {
    return Errors.forbidden("Not a member of this room").toResponse();
  }

  // Check user has permission to send m.room.tombstone events
  // User needs power level >= events['m.room.tombstone'] (default 100 for state events)
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

  // Get current room state to copy to new room
  const currentState = await getRoomState(db, oldRoomId);
  const now = Date.now();

  // Generate new room ID
  const newRoomId = await generateRoomId(serverName);

  // Get the last event ID from old room for predecessor
  const lastEvent = await db
    .prepare(`
    SELECT event_id FROM events WHERE room_id = ? ORDER BY depth DESC LIMIT 1
  `)
    .bind(oldRoomId)
    .first<{ event_id: string }>();

  // Create the new room
  await createRoom(db, newRoomId, body.new_version, userId, false);

  let depth = 0;
  const authEvents: string[] = [];
  const prevEvents: string[] = [];

  // Helper to create events in new room
  async function createNewRoomEvent(
    type: string,
    content: any,
    stateKey?: string,
  ): Promise<string> {
    const eventId = await generateEventId(serverName);
    const event: PDU = {
      event_id: eventId,
      room_id: newRoomId,
      sender: userId,
      type,
      state_key: stateKey,
      content,
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

  // 1. Create m.room.create with predecessor
  const createContent: RoomCreateContent = {
    creator: userId,
    room_version: body.new_version,
    predecessor: {
      room_id: oldRoomId,
      event_id: lastEvent?.event_id || "",
    },
  };
  await createNewRoomEvent("m.room.create", createContent, "");

  // 2. Creator joins
  const joinEventId = await createNewRoomEvent("m.room.member", { membership: "join" }, userId);
  await updateMembership(db, newRoomId, userId, "join", joinEventId);

  // 3. Copy power levels (with adjustments)
  if (powerLevels) {
    await createNewRoomEvent("m.room.power_levels", powerLevels, "");
  } else {
    // Default power levels
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

  // 4. Copy join rules
  const joinRulesEvent = currentState.find((e) => e.type === "m.room.join_rules");
  if (joinRulesEvent) {
    const content =
      typeof joinRulesEvent.content === "string"
        ? JSON.parse(joinRulesEvent.content)
        : joinRulesEvent.content;
    await createNewRoomEvent("m.room.join_rules", content, "");
  } else {
    await createNewRoomEvent("m.room.join_rules", { join_rule: "invite" }, "");
  }

  // 5. Copy history visibility
  const historyEvent = currentState.find((e) => e.type === "m.room.history_visibility");
  if (historyEvent) {
    const content =
      typeof historyEvent.content === "string"
        ? JSON.parse(historyEvent.content)
        : historyEvent.content;
    await createNewRoomEvent("m.room.history_visibility", content, "");
  } else {
    await createNewRoomEvent("m.room.history_visibility", { history_visibility: "shared" }, "");
  }

  // 6. Copy room name
  const nameEvent = currentState.find((e) => e.type === "m.room.name");
  if (nameEvent) {
    const content =
      typeof nameEvent.content === "string" ? JSON.parse(nameEvent.content) : nameEvent.content;
    await createNewRoomEvent("m.room.name", content, "");
  }

  // 7. Copy room topic
  const topicEvent = currentState.find((e) => e.type === "m.room.topic");
  if (topicEvent) {
    const content =
      typeof topicEvent.content === "string" ? JSON.parse(topicEvent.content) : topicEvent.content;
    await createNewRoomEvent("m.room.topic", content, "");
  }

  // 8. Copy room avatar
  const avatarEvent = currentState.find((e) => e.type === "m.room.avatar");
  if (avatarEvent) {
    const content =
      typeof avatarEvent.content === "string"
        ? JSON.parse(avatarEvent.content)
        : avatarEvent.content;
    await createNewRoomEvent("m.room.avatar", content, "");
  }

  // 9. Copy encryption settings
  const encryptionEvent = currentState.find((e) => e.type === "m.room.encryption");
  if (encryptionEvent) {
    const content =
      typeof encryptionEvent.content === "string"
        ? JSON.parse(encryptionEvent.content)
        : encryptionEvent.content;
    await createNewRoomEvent("m.room.encryption", content, "");
  }

  // 10. Copy guest access
  const guestAccessEvent = currentState.find((e) => e.type === "m.room.guest_access");
  if (guestAccessEvent) {
    const content =
      typeof guestAccessEvent.content === "string"
        ? JSON.parse(guestAccessEvent.content)
        : guestAccessEvent.content;
    await createNewRoomEvent("m.room.guest_access", content, "");
  }

  // Now send tombstone to old room
  const oldRoomState = await getRoomState(db, oldRoomId);
  const oldPrevEvent = await db
    .prepare(`
    SELECT event_id, depth FROM events WHERE room_id = ? ORDER BY depth DESC LIMIT 1
  `)
    .bind(oldRoomId)
    .first<{ event_id: string; depth: number }>();

  const oldAuthEvents = oldRoomState
    .filter((e) => ["m.room.create", "m.room.power_levels", "m.room.member"].includes(e.type))
    .filter((e) => e.state_key === "" || e.state_key === userId)
    .map((e) => e.event_id);

  const tombstoneEventId = await generateEventId(serverName);
  const tombstoneEvent: PDU = {
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
  };

  await storeEvent(db, tombstoneEvent);

  // Update old room's power levels to restrict posting
  // Elevate events_default to prevent casual messaging
  const newPowerLevels = powerLevels
    ? { ...powerLevels }
    : {
        users: { [userId]: 100 },
        users_default: 0,
        events_default: 100, // Set high to prevent messaging
        state_default: 100,
        ban: 100,
        kick: 100,
        redact: 100,
        invite: 100,
      };
  newPowerLevels.events_default = 100;
  newPowerLevels.invite = 100;

  const restrictEventId = await generateEventId(serverName);
  const restrictEvent: PDU = {
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
  };

  await storeEvent(db, restrictEvent);

  // Migrate local room aliases to point to new room
  const aliases = await db
    .prepare(`
    SELECT alias FROM room_aliases WHERE room_id = ?
  `)
    .bind(oldRoomId)
    .all<{ alias: string }>();

  for (const aliasRow of aliases.results) {
    await db
      .prepare(`
      UPDATE room_aliases SET room_id = ? WHERE alias = ?
    `)
      .bind(newRoomId, aliasRow.alias)
      .run();
  }

  return c.json({
    replacement_room: newRoomId,
  });
});

export default app;
