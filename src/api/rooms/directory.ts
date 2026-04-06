import { Hono } from "hono";
import type { AppEnv } from "../../types";
import { Errors } from "../../utils/errors";
import { requireAuth } from "../../middleware/auth";
import { federationGet } from "../../services/federation-keys";
import {
  createRoomAlias,
  deleteRoomAlias,
  getMembership,
  getRoomByAlias,
  getStateEvent,
} from "../../services/database";
import { parseRoomAlias } from "../../utils/ids";
import { hashToken } from "../../utils/crypto";
import {
  canUserSendStateEvent,
  getUserPowerLevelFromContent,
  isRecord,
  parseOptionalJsonObjectBody,
  removeDeletedAliasFromCanonicalContent,
  resolveRoomIdOrAlias,
  toRouteErrorResponse,
} from "./shared";

const app = new Hono<AppEnv>();

app.get("/_matrix/client/v3/rooms/:roomId/aliases", requireAuth(), async (c) => {
  const userId = c.get("userId");
  const roomId = c.req.param("roomId");

  const membership = await getMembership(c.env.DB, roomId, userId);
  if (!membership || membership.membership !== "join") {
    return Errors.forbidden("Not a member of this room").toResponse();
  }

  const aliases = await c.env.DB.prepare(`SELECT alias FROM room_aliases WHERE room_id = ?`)
    .bind(roomId)
    .all<{ alias: string }>();

  return c.json({
    aliases: aliases.results.map((row) => row.alias),
  });
});

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
    const response = toRouteErrorResponse(error);
    if (response) {
      return response;
    }
    throw error;
  }
});

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

  const body = (await response.json()) as { room_id?: unknown; servers?: unknown };
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

app.put("/_matrix/client/v3/directory/room/:roomAlias", requireAuth(), async (c) => {
  const userId = c.get("userId");
  const alias = decodeURIComponent(c.req.param("roomAlias"));

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  if (!isRecord(body) || typeof body.room_id !== "string") {
    return Errors.missingParam("room_id").toResponse();
  }

  const existing = await getRoomByAlias(c.env.DB, alias);
  if (existing) {
    return Errors.roomInUse().toResponse();
  }

  const membership = await getMembership(c.env.DB, body.room_id, userId);
  if (!membership || membership.membership !== "join") {
    return Errors.forbidden("Not a member of this room").toResponse();
  }

  await createRoomAlias(c.env.DB, alias, body.room_id, userId);
  return c.json({});
});

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

app.get("/_matrix/client/v1/room_summary/:roomIdOrAlias", async (c) => {
  const roomIdOrAlias = decodeURIComponent(c.req.param("roomIdOrAlias"));
  const db = c.env.DB;
  let roomId = roomIdOrAlias;

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

  const room = await db
    .prepare(`SELECT room_id, room_version, is_public FROM rooms WHERE room_id = ?`)
    .bind(roomId)
    .first<{ room_id: string; room_version: string; is_public: number }>();

  if (!room) {
    return Errors.notFound("Room not found").toResponse();
  }

  const stateEvents = await db
    .prepare(
      `SELECT e.event_type, e.content FROM room_state rs
       JOIN events e ON rs.event_id = e.event_id
       WHERE rs.room_id = ? AND rs.event_type IN (
         'm.room.name', 'm.room.topic', 'm.room.avatar',
         'm.room.join_rules', 'm.room.canonical_alias', 'm.room.encryption',
         'm.room.history_visibility', 'm.room.guest_access'
       )`,
    )
    .bind(roomId)
    .all<{ event_type: string; content: string }>();
  const memberCount = await db
    .prepare(
      `SELECT COUNT(*) as count FROM room_memberships WHERE room_id = ? AND membership = 'join'`,
    )
    .bind(roomId)
    .first<{ count: number }>();

  const response: Record<string, unknown> = {
    room_id: roomId,
    num_joined_members: memberCount?.count ?? 0,
    room_version: room.room_version,
  };

  let joinRule = "invite";
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
        worldReadable = content.history_visibility === "world_readable";
        break;
      case "m.room.guest_access":
        guestCanJoin = content.guest_access === "can_join";
        break;
    }
  }

  response.world_readable = worldReadable;
  response.guest_can_join = guestCanJoin;

  const authHeader = c.req.header("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const tokenHash = await hashToken(authHeader.slice(7));
    const tokenResult = await db
      .prepare(`SELECT user_id FROM access_tokens WHERE token_hash = ?`)
      .bind(tokenHash)
      .first<{ user_id: string }>();

    if (tokenResult) {
      const membership = await db
        .prepare(`SELECT membership FROM room_memberships WHERE room_id = ? AND user_id = ?`)
        .bind(roomId, tokenResult.user_id)
        .first<{ membership: string }>();
      response.membership = membership?.membership ?? "leave";
    }
  }

  if (!room.is_public && !worldReadable && !response.membership) {
    if (!["public", "knock", "knock_restricted"].includes(joinRule)) {
      return Errors.notFound("Room not found").toResponse();
    }
  }

  return c.json(response);
});

export default app;
