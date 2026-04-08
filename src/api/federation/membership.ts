import { Hono } from "hono";
import { Effect } from "effect";
import type { AppEnv, EventId, MatrixSignatures, Membership, PDU, RoomId } from "../../types";
import { Errors } from "../../utils/errors";
import {
  calculateReferenceHashEventId,
  sha256,
  signJson,
  verifySignature,
} from "../../utils/crypto";
import { getServerSigningKey } from "../../services/federation-keys";
import { fanoutEventToFederation, notifyUsersOfEvent, storeEvent } from "../../services/database";
import { checkEventAuth } from "../../services/event-auth";
import {
  applyMembershipTransitionToDatabase,
  loadMembershipTransitionContext,
} from "../../matrix/application/membership-transition-service";
import {
  decideInvitePermission,
  loadInvitePermissionConfig,
} from "../../matrix/application/features/invite-permissions/policy";
import { getPartialStateJoinForRoom } from "../../matrix/application/features/partial-state/tracker";
import {
  ensureFederatedRoomStub,
  loadFederationStateBundle,
  persistFederationMembershipEvent,
  persistInviteStrippedState,
} from "../../matrix/application/federation-handler-service";
import { requiresFullCreateEventInStrippedState } from "../../matrix/application/features/rooms/room-version-semantics";
import {
  type FederationThirdPartyInviteValidationResult,
  validateInviteRequest,
  validateSendJoinRequest,
  validateSendKnockRequest,
  validateSendLeaveRequest,
  validateThirdPartyInviteExchangeRequest,
} from "../../matrix/application/federation-validation";
import {
  authorizeLocalJoin,
  authorizeLocalKnock,
  type JoinRulesContent,
} from "../../matrix/application/room-membership-policy";
import { runFederationEffect } from "../../matrix/application/effect-runtime";
import {
  logFederationRouteWarning,
  runDomainValidation,
  toFederationErrorResponse,
} from "./shared";
import { toEventId, toRoomId, toUserId } from "../../utils/ids";

const app = new Hono<AppEnv>();

async function ensureRoomNotPartiallyJoined(c: import("hono").Context<AppEnv>, roomId: RoomId) {
  const partialStateJoin = await getPartialStateJoinForRoom(c.env.CACHE, roomId);
  if (partialStateJoin) {
    return Errors.notFound("Room not found").toResponse();
  }

  return null;
}

function buildPartialSendJoinResponse(stateBundle: {
  state: PDU[];
  authChain: PDU[];
  serversInRoom: string[];
}) {
  const essentialStateTypes = new Set([
    "m.room.create",
    "m.room.power_levels",
    "m.room.join_rules",
    "m.room.history_visibility",
  ]);
  const state = stateBundle.state.filter(
    (event) =>
      essentialStateTypes.has(event.type) ||
      (event.type === "m.room.member" && event.content?.membership === "join"),
  );
  const stateEventIds = new Set(state.map((event) => event.event_id));
  const authChain = stateBundle.authChain.filter((event) => !stateEventIds.has(event.event_id));

  return {
    auth_chain: authChain,
    state,
    members_omitted: true,
    servers_in_room: stateBundle.serversInRoom,
  };
}

app.get("/_matrix/federation/v1/make_join/:roomId/:userId", async (c) => {
  const roomId = toRoomId(c.req.param("roomId"));
  const userId = toUserId(c.req.param("userId"));
  if (!roomId || !userId) {
    return Errors.invalidParam("roomId", "Invalid room or user ID").toResponse();
  }
  const partialStateResponse = await ensureRoomNotPartiallyJoined(c, roomId);
  if (partialStateResponse) {
    return partialStateResponse;
  }

  const room = await c.env.DB.prepare(`SELECT room_id, room_version FROM rooms WHERE room_id = ?`)
    .bind(roomId)
    .first();
  if (!room) {
    return Errors.notFound("Room not found").toResponse();
  }

  const createEvent = await c.env.DB.prepare(
    `SELECT e.event_id FROM room_state rs
     JOIN events e ON rs.event_id = e.event_id
     WHERE rs.room_id = ? AND rs.event_type = 'm.room.create'`,
  )
    .bind(roomId)
    .first<{ event_id: string }>();
  const joinRulesEvent = await c.env.DB.prepare(
    `SELECT e.event_id, e.content FROM room_state rs
     JOIN events e ON rs.event_id = e.event_id
     WHERE rs.room_id = ? AND rs.event_type = 'm.room.join_rules'`,
  )
    .bind(roomId)
    .first<{ event_id: string; content: string }>();
  const powerLevelsEvent = await c.env.DB.prepare(
    `SELECT e.event_id FROM room_state rs
     JOIN events e ON rs.event_id = e.event_id
     WHERE rs.room_id = ? AND rs.event_type = 'm.room.power_levels'`,
  )
    .bind(roomId)
    .first<{ event_id: string }>();
  const currentMembership = await c.env.DB.prepare(
    `SELECT membership, event_id FROM room_memberships WHERE room_id = ? AND user_id = ?`,
  )
    .bind(roomId, userId)
    .first<{ membership: string; event_id: string }>();
  const currentStateMembership = await c.env.DB.prepare(
    `SELECT e.event_id, json_extract(e.content, '$.membership') AS membership
     FROM room_state rs
     JOIN events e ON rs.event_id = e.event_id
     WHERE rs.room_id = ? AND rs.event_type = 'm.room.member' AND rs.state_key = ?`,
  )
    .bind(roomId, userId)
    .first<{ event_id: string; membership: string | null }>();

  const joinRulesContent = joinRulesEvent
    ? (JSON.parse(joinRulesEvent.content) as JoinRulesContent)
    : null;

  try {
    const makeJoinDb = c.env.DB;
    await runFederationEffect(
      authorizeLocalJoin({
        roomVersion: String(room.room_version),
        joinRulesContent,
        currentMembership: currentMembership?.membership as Membership | undefined,
        checkAllowedRoomMembership: (allowedRoomId) =>
          Effect.promise(() =>
            makeJoinDb
              .prepare(`SELECT membership FROM room_memberships WHERE room_id = ? AND user_id = ?`)
              .bind(allowedRoomId, userId)
              .first<{ membership: string }>()
              .then((m) => m?.membership === "join")
              .catch(() => false),
          ),
      }),
    );
  } catch (error) {
    const response = toFederationErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const authEvents: string[] = [];
  if (createEvent) authEvents.push(createEvent.event_id);
  if (joinRulesEvent) authEvents.push(joinRulesEvent.event_id);
  if (powerLevelsEvent) authEvents.push(powerLevelsEvent.event_id);
  if (currentMembership?.event_id) authEvents.push(currentMembership.event_id);

  const latestEvent = await c.env.DB.prepare(
    `SELECT event_id, depth FROM events WHERE room_id = ? ORDER BY depth DESC LIMIT 1`,
  )
    .bind(roomId)
    .first<{ event_id: string; depth: number }>();
  const prevEvents = latestEvent ? [latestEvent.event_id] : [];
  const depth = (latestEvent?.depth ?? 0) + 1;

  const eventTemplate = {
    room_id: roomId,
    sender: userId,
    type: "m.room.member",
    state_key: userId,
    content: { membership: "join" },
    origin_server_ts: Date.now(),
    depth,
    auth_events: authEvents,
    prev_events: prevEvents,
  };

  await logFederationRouteWarning(c, "make_join", {
    roomId,
    userId,
    roomVersion: room.room_version,
    currentMembership: currentMembership?.membership,
    currentMembershipEventId: currentMembership?.event_id,
    currentStateMembership: currentStateMembership?.membership,
    currentStateMembershipEventId: currentStateMembership?.event_id,
    authEvents,
    prevEvents,
    depth,
  });

  return c.json({
    room_version: room.room_version,
    event: eventTemplate,
  });
});

async function handleSendJoin(c: any, version: "v1" | "v2"): Promise<Response> {
  const roomId = c.req.param("roomId");
  const eventId = c.req.param("eventId");
  const omitMembers = c.req.query("omit_members") === "true";
  const origin = c.get("federationOrigin" as any) as string | undefined;
  const partialStateResponse = await ensureRoomNotPartiallyJoined(c, roomId);
  if (partialStateResponse) {
    return partialStateResponse;
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  try {
    const validated = await runDomainValidation(validateSendJoinRequest({ body, roomId, eventId }));

    const room = await c.env.DB.prepare(`SELECT room_id, room_version FROM rooms WHERE room_id = ?`)
      .bind(roomId)
      .first();
    if (!room) {
      return Errors.notFound("Room not found").toResponse();
    }

    const incomingEvent = validated.event;
    const currentMembership = await c.env.DB.prepare(
      `SELECT json_extract(e.content, '$.membership') AS membership
       FROM room_state rs
       JOIN events e ON rs.event_id = e.event_id
       WHERE rs.room_id = ? AND rs.event_type = 'm.room.member' AND rs.state_key = ?`,
    )
      .bind(roomId, incomingEvent.state_key)
      .first();
    if (currentMembership?.membership === "ban") {
      return c.json({ errcode: "M_FORBIDDEN", error: "User is banned from this room" }, 403);
    }

    const calculatedEventId = await calculateReferenceHashEventId(
      incomingEvent as unknown as Record<string, unknown>,
      room.room_version,
    );
    await logFederationRouteWarning(c, "send_join", {
      roomId,
      eventId,
      roomVersion: room.room_version,
      calculatedEventId,
      originServerTs: incomingEvent.origin_server_ts,
      depth: incomingEvent.depth,
      authEvents: incomingEvent.auth_events,
      prevEvents: incomingEvent.prev_events,
      pathMatchesCalculated: eventId === calculatedEventId,
    });

    const stateBundle = await loadFederationStateBundle(c.env.DB, roomId);
    const authResult = checkEventAuth(incomingEvent, stateBundle.roomState, room.room_version);
    if (!authResult.allowed) {
      return c.json(
        { errcode: "M_FORBIDDEN", error: authResult.error ?? "Join event not allowed" },
        403,
      );
    }

    await persistFederationMembershipEvent(c.env.DB, {
      roomId,
      event: incomingEvent,
      source: "federation",
    });

    c.executionCtx.waitUntil(
      fanoutEventToFederation(c.env, roomId, incomingEvent, {
        excludeServers: origin ? [origin] : undefined,
      }),
    );

    const partialResponse = omitMembers ? buildPartialSendJoinResponse(stateBundle) : null;
    if (version === "v1") {
      return c.json({
        origin: c.env.SERVER_NAME,
        auth_chain: partialResponse?.auth_chain ?? stateBundle.authChain,
        state: partialResponse?.state ?? stateBundle.state,
        event: incomingEvent,
      });
    }

    return c.json({
      origin: c.env.SERVER_NAME,
      auth_chain: partialResponse?.auth_chain ?? stateBundle.authChain,
      state: partialResponse?.state ?? stateBundle.state,
      event: incomingEvent,
      members_omitted: partialResponse?.members_omitted ?? false,
      servers_in_room: stateBundle.serversInRoom,
    });
  } catch (error) {
    const response = toFederationErrorResponse(error);
    if (response) {
      return response;
    }
    throw error;
  }
}

app.put("/_matrix/federation/v1/send_join/:roomId/:eventId", (c) => handleSendJoin(c, "v1"));
app.put("/_matrix/federation/v2/send_join/:roomId/:eventId", (c) => handleSendJoin(c, "v2"));

app.get("/_matrix/federation/v1/make_leave/:roomId/:userId", async (c) => {
  const roomId = c.req.param("roomId");
  const userId = c.req.param("userId");

  const room = await c.env.DB.prepare(`SELECT room_id, room_version FROM rooms WHERE room_id = ?`)
    .bind(roomId)
    .first();
  if (!room) {
    return Errors.notFound("Room not found").toResponse();
  }

  const membership = await c.env.DB.prepare(
    `SELECT event_id, membership FROM room_memberships WHERE room_id = ? AND user_id = ?`,
  )
    .bind(roomId, userId)
    .first<{ event_id: string; membership: string }>();
  const currentStateMembership = await c.env.DB.prepare(
    `SELECT e.event_id, json_extract(e.content, '$.membership') AS membership
     FROM room_state rs
     JOIN events e ON rs.event_id = e.event_id
     WHERE rs.room_id = ? AND rs.event_type = 'm.room.member' AND rs.state_key = ?`,
  )
    .bind(roomId, userId)
    .first<{ event_id: string; membership: string | null }>();

  if (!membership || !["join", "invite", "knock"].includes(membership.membership)) {
    return c.json(
      { errcode: "M_FORBIDDEN", error: "User is not joined, invited, or knocking in the room" },
      403,
    );
  }

  const createEvent = await c.env.DB.prepare(
    `SELECT e.event_id FROM room_state rs
     JOIN events e ON rs.event_id = e.event_id
     WHERE rs.room_id = ? AND rs.event_type = 'm.room.create'`,
  )
    .bind(roomId)
    .first<{ event_id: string }>();
  const powerLevelsEvent = await c.env.DB.prepare(
    `SELECT e.event_id FROM room_state rs
     JOIN events e ON rs.event_id = e.event_id
     WHERE rs.room_id = ? AND rs.event_type = 'm.room.power_levels'`,
  )
    .bind(roomId)
    .first<{ event_id: string }>();

  const authEvents: string[] = [];
  if (createEvent) authEvents.push(createEvent.event_id);
  if (powerLevelsEvent) authEvents.push(powerLevelsEvent.event_id);
  authEvents.push(membership.event_id);

  const latestEvent = await c.env.DB.prepare(
    `SELECT event_id, depth FROM events WHERE room_id = ? ORDER BY depth DESC LIMIT 1`,
  )
    .bind(roomId)
    .first<{ event_id: string; depth: number }>();
  const prevEvents = latestEvent ? [latestEvent.event_id] : [];
  const depth = (latestEvent?.depth ?? 0) + 1;

  await logFederationRouteWarning(c, "make_leave", {
    roomId,
    userId,
    roomVersion: room.room_version,
    currentMembership: membership.membership,
    currentMembershipEventId: membership.event_id,
    currentStateMembership: currentStateMembership?.membership,
    currentStateMembershipEventId: currentStateMembership?.event_id,
    authEvents,
    prevEvents,
    depth,
  });

  return c.json({
    room_version: room.room_version,
    event: {
      room_id: roomId,
      sender: userId,
      type: "m.room.member",
      state_key: userId,
      content: { membership: "leave" },
      origin_server_ts: Date.now(),
      depth,
      auth_events: authEvents,
      prev_events: prevEvents,
    },
  });
});

async function persistFederationLeave(
  c: any,
  roomId: RoomId,
  event: PDU,
  roomVersion: string,
  origin?: string,
): Promise<PDU> {
  const leaveEventId = event.event_id;
  const leavePdu: PDU = {
    ...event,
    room_id: roomId,
  };
  const calculatedEventId = await calculateReferenceHashEventId(
    leavePdu as unknown as Record<string, unknown>,
    roomVersion,
  );
  await logFederationRouteWarning(c, "send_leave", {
    roomId,
    eventId: leaveEventId,
    calculatedEventId,
    originServerTs: leavePdu.origin_server_ts,
    depth: leavePdu.depth,
    authEvents: leavePdu.auth_events,
    prevEvents: leavePdu.prev_events,
    pathMatchesCalculated: leaveEventId === calculatedEventId,
  });

  const existing = await c.env.DB.prepare(`SELECT event_id FROM events WHERE event_id = ?`)
    .bind(leaveEventId)
    .first();
  const leaveTransitionContext = await loadMembershipTransitionContext(
    c.env.DB,
    roomId,
    leavePdu.state_key,
  );
  if (!existing) {
    await storeEvent(c.env.DB, leavePdu);
  }

  await applyMembershipTransitionToDatabase(c.env.DB, {
    roomId,
    event: leavePdu,
    source: "federation",
    context: leaveTransitionContext,
  });

  await notifyUsersOfEvent(c.env, roomId, leaveEventId, "m.room.member");
  c.executionCtx.waitUntil(
    fanoutEventToFederation(c.env, roomId, leavePdu, {
      excludeServers: origin ? [origin] : undefined,
    }),
  );

  return leavePdu;
}

async function handleSendLeave(c: any, version: "v1" | "v2"): Promise<Response> {
  const roomId = toRoomId(c.req.param("roomId"));
  const eventId = toEventId(c.req.param("eventId"));
  const origin = c.get("federationOrigin" as any) as string | undefined;
  if (!roomId || !eventId) {
    return Errors.invalidParam("roomId", "Invalid room or event ID").toResponse();
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  const room = await c.env.DB.prepare(`SELECT room_id, room_version FROM rooms WHERE room_id = ?`)
    .bind(roomId)
    .first();
  if (!room) {
    return Errors.notFound("Room not found").toResponse();
  }

  let validatedLeave;
  try {
    validatedLeave = await runDomainValidation(validateSendLeaveRequest({ body, roomId, eventId }));
  } catch (error) {
    const response = toFederationErrorResponse(error);
    if (response) {
      return response;
    }
    throw error;
  }
  await persistFederationLeave(c, roomId, validatedLeave.event, room.room_version, origin);
  return version === "v1" ? c.json([200, {}]) : c.json({});
}

app.put("/_matrix/federation/v1/send_leave/:roomId/:eventId", (c) => handleSendLeave(c, "v1"));
app.put("/_matrix/federation/v2/send_leave/:roomId/:eventId", (c) => handleSendLeave(c, "v2"));

async function handleFederationInvite(c: any, version: "v1" | "v2"): Promise<Response> {
  const roomId = toRoomId(c.req.param("roomId"));
  const eventId = toEventId(c.req.param("eventId"));
  if (!roomId || !eventId) {
    return Errors.invalidParam("roomId", "Invalid room or event ID").toResponse();
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  try {
    const validated = await runDomainValidation(
      validateInviteRequest({
        body,
        eventId,
        serverName: c.env.SERVER_NAME,
        requireRoomVersion: version === "v2",
      }),
    );

    const invitedUserId = toUserId(validated.invitedUserId);
    if (!invitedUserId) {
      return Errors.invalidParam("userId", "Invalid user ID").toResponse();
    }
    const sender = toUserId(validated.event.sender);
    if (!sender) {
      return Errors.invalidParam("userId", "Invalid user ID").toResponse();
    }

    const localUser = await c.env.DB.prepare(`SELECT user_id FROM users WHERE user_id = ?`)
      .bind(invitedUserId)
      .first();
    if (!localUser) {
      return c.json({ errcode: "M_NOT_FOUND", error: "User not found" }, 404);
    }

    const invitePermissionConfig = await loadInvitePermissionConfig(c.env.DB, invitedUserId);
    const decision = decideInvitePermission(
      invitePermissionConfig,
      sender,
      typeof c.get("federationOrigin") === "string"
        ? (c.get("federationOrigin") as string)
        : undefined,
    );
    if (decision.action === "block") {
      await logFederationRouteWarning(c, "invite", {
        decision: "invite_blocked",
        room_id: validated.roomId,
        invited_user_id: invitedUserId,
        sender,
        matched_by: decision.matchedBy,
        matched_value: decision.matchedValue,
      });
      return Errors.inviteBlocked().toResponse();
    }

    const key = await getServerSigningKey(c.env.DB);
    if (!key) {
      return c.json({ errcode: "M_UNKNOWN", error: "Server signing key not configured" }, 500);
    }

    const signedEvent = (await signJson(
      validated.event as unknown as Record<string, unknown>,
      c.env.SERVER_NAME,
      key.keyId,
      key.privateKeyJwk,
    )) as Record<string, any>;

    await ensureFederatedRoomStub(c.env.DB, roomId, validated.roomVersion, sender);

    const invitePdu: PDU = {
      ...validated.event,
      event_id: signedEvent.event_id ?? validated.event.event_id,
      room_id: roomId,
      sender: signedEvent.sender ?? sender,
      type: signedEvent.type ?? validated.event.type,
      state_key: signedEvent.state_key ?? validated.event.state_key,
      content: signedEvent.content ?? validated.event.content,
      origin_server_ts: signedEvent.origin_server_ts ?? validated.event.origin_server_ts,
      depth: signedEvent.depth ?? validated.event.depth,
      auth_events: signedEvent.auth_events ?? validated.event.auth_events,
      prev_events: signedEvent.prev_events ?? validated.event.prev_events,
      unsigned: signedEvent.unsigned ?? validated.event.unsigned,
      hashes: signedEvent.hashes as { sha256: string } | undefined,
      signatures: signedEvent.signatures as MatrixSignatures | undefined,
    };

    await persistFederationMembershipEvent(c.env.DB, {
      roomId,
      event: invitePdu,
      source: "federation",
    });
    await persistInviteStrippedState(c.env.DB, roomId, validated.inviteRoomState);

    return version === "v1" ? c.json([200, signedEvent]) : c.json({ event: signedEvent });
  } catch (error) {
    const response = toFederationErrorResponse(error);
    if (response) {
      return response;
    }
    throw error;
  }
}

app.put("/_matrix/federation/v1/invite/:roomId/:eventId", (c) => handleFederationInvite(c, "v1"));
app.put("/_matrix/federation/v2/invite/:roomId/:eventId", (c) => handleFederationInvite(c, "v2"));

app.get("/_matrix/federation/v1/make_knock/:roomId/:userId", async (c) => {
  const roomId = toRoomId(c.req.param("roomId"));
  const userId = toUserId(c.req.param("userId"));
  if (!roomId || !userId) {
    return Errors.invalidParam("roomId", "Invalid room or user ID").toResponse();
  }
  const db = c.env.DB;
  const partialStateResponse = await ensureRoomNotPartiallyJoined(c, roomId);
  if (partialStateResponse) {
    return partialStateResponse;
  }

  const room = await db
    .prepare(`SELECT room_id, room_version FROM rooms WHERE room_id = ?`)
    .bind(roomId)
    .first<{ room_id: string; room_version: string }>();
  if (!room) {
    return Errors.notFound("Room not found").toResponse();
  }

  const joinRulesRow = await db
    .prepare(
      `SELECT e.event_id, e.content FROM room_state rs
       JOIN events e ON rs.event_id = e.event_id
       WHERE rs.room_id = ? AND rs.event_type = 'm.room.join_rules'`,
    )
    .bind(roomId)
    .first<{ event_id: string; content: string }>();
  const membership = await db
    .prepare(`SELECT membership FROM room_memberships WHERE room_id = ? AND user_id = ?`)
    .bind(roomId, userId)
    .first<{ membership: string }>();

  try {
    await runFederationEffect(
      authorizeLocalKnock({
        roomVersion: room.room_version,
        joinRule: joinRulesRow
          ? (JSON.parse(joinRulesRow.content) as JoinRulesContent).join_rule
          : undefined,
        currentMembership: membership?.membership as Membership | undefined,
      }),
    );
  } catch (error) {
    const response = toFederationErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const createEvent = await db
    .prepare(
      `SELECT e.event_id FROM room_state rs
       JOIN events e ON rs.event_id = e.event_id
       WHERE rs.room_id = ? AND rs.event_type = 'm.room.create'`,
    )
    .bind(roomId)
    .first<{ event_id: string }>();
  const powerLevelsEvent = await db
    .prepare(
      `SELECT e.event_id FROM room_state rs
       JOIN events e ON rs.event_id = e.event_id
       WHERE rs.room_id = ? AND rs.event_type = 'm.room.power_levels'`,
    )
    .bind(roomId)
    .first<{ event_id: string }>();

  const authEvents: EventId[] = [];
  for (const candidate of [createEvent, joinRulesRow, powerLevelsEvent]) {
    if (!candidate) continue;
    const candidateEventId = toEventId(candidate.event_id);
    if (candidateEventId) {
      authEvents.push(candidateEventId);
    }
  }

  const latestEvent = await db
    .prepare(`SELECT event_id, depth FROM events WHERE room_id = ? ORDER BY depth DESC LIMIT 1`)
    .bind(roomId)
    .first<{ event_id: string; depth: number }>();
  const prevEventId = latestEvent ? toEventId(latestEvent.event_id) : null;
  const prevEvents: EventId[] = prevEventId ? [prevEventId] : [];
  const depth = (latestEvent?.depth ?? 0) + 1;

  return c.json({
    room_version: room.room_version,
    event: {
      room_id: roomId,
      sender: userId,
      type: "m.room.member",
      state_key: userId,
      content: { membership: "knock" },
      origin_server_ts: Date.now(),
      depth,
      auth_events: authEvents,
      prev_events: prevEvents,
    },
  });
});

app.put("/_matrix/federation/v1/send_knock/:roomId/:eventId", async (c) => {
  const roomId = toRoomId(c.req.param("roomId"));
  const eventId = toEventId(c.req.param("eventId"));
  if (!roomId || !eventId) {
    return Errors.invalidParam("roomId", "Invalid room or event ID").toResponse();
  }
  const origin = c.get("federationOrigin" as any) as string | undefined;
  const db = c.env.DB;
  const partialStateResponse = await ensureRoomNotPartiallyJoined(c, roomId);
  if (partialStateResponse) {
    return partialStateResponse;
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  let validatedKnock;
  try {
    validatedKnock = await runDomainValidation(validateSendKnockRequest({ body, roomId, eventId }));
  } catch (error) {
    const response = toFederationErrorResponse(error);
    if (response) {
      return response;
    }
    throw error;
  }

  const room = await db
    .prepare(`SELECT room_id, room_version FROM rooms WHERE room_id = ?`)
    .bind(roomId)
    .first<{ room_id: string; room_version: string }>();
  if (!room) {
    return Errors.notFound("Room not found").toResponse();
  }

  const userId = toUserId(validatedKnock.event.state_key);
  if (!userId) {
    return Errors.invalidParam("userId", "Invalid user ID").toResponse();
  }
  const sendKnockJoinRulesEvent = await db
    .prepare(
      `SELECT e.content FROM room_state rs
       JOIN events e ON rs.event_id = e.event_id
       WHERE rs.room_id = ? AND rs.event_type = 'm.room.join_rules'`,
    )
    .bind(roomId)
    .first<{ content: string }>();
  const sendKnockMembership = await db
    .prepare(`SELECT membership FROM room_memberships WHERE room_id = ? AND user_id = ?`)
    .bind(roomId, userId)
    .first<{ membership: string }>();

  try {
    await runFederationEffect(
      authorizeLocalKnock({
        roomVersion: room.room_version,
        joinRule: sendKnockJoinRulesEvent
          ? (JSON.parse(sendKnockJoinRulesEvent.content) as JoinRulesContent).join_rule
          : undefined,
        currentMembership: sendKnockMembership?.membership as Membership | undefined,
      }),
    );
  } catch (error) {
    const response = toFederationErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const knockPdu = validatedKnock.event;
  try {
    await persistFederationMembershipEvent(db, {
      roomId,
      event: knockPdu,
      source: "federation",
    });
    await notifyUsersOfEvent(c.env, roomId, eventId, "m.room.member");
    c.executionCtx.waitUntil(
      fanoutEventToFederation(c.env, roomId, knockPdu, {
        excludeServers: origin ? [origin] : undefined,
      }),
    );
  } catch (error) {
    console.error(`Failed to store knock event ${eventId}:`, error);
  }

  const strippedState: Array<Record<string, unknown>> = [];
  const strippedStateTypes = [
    "m.room.create",
    "m.room.name",
    "m.room.avatar",
    "m.room.join_rules",
    "m.room.canonical_alias",
  ] as const;
  const useFullCreateEvent = requiresFullCreateEventInStrippedState(room.room_version);
  for (const eventType of strippedStateTypes) {
    // MSC4311: For v12+ rooms, include the full create event (not stripped).
    if (eventType === "m.room.create" && useFullCreateEvent) {
      const fullEvent = await db
        .prepare(
          `SELECT e.event_id, e.room_id, e.event_type, e.state_key, e.content,
                  e.sender, e.origin_server_ts, e.depth, e.auth_events, e.prev_events,
                  e.hashes, e.signatures
           FROM room_state rs
           JOIN events e ON rs.event_id = e.event_id
           WHERE rs.room_id = ? AND rs.event_type = 'm.room.create'`,
        )
        .bind(roomId)
        .first<{
          event_id: string;
          room_id: string;
          event_type: string;
          state_key: string;
          content: string;
          sender: string;
          origin_server_ts: number;
          depth: number;
          auth_events: string;
          prev_events: string;
          hashes: string | null;
          signatures: string | null;
        }>();
      if (fullEvent) {
        strippedState.push({
          event_id: fullEvent.event_id,
          room_id: fullEvent.room_id,
          type: fullEvent.event_type,
          state_key: fullEvent.state_key,
          content: JSON.parse(fullEvent.content),
          sender: fullEvent.sender,
          origin_server_ts: fullEvent.origin_server_ts,
          depth: fullEvent.depth,
          auth_events: JSON.parse(fullEvent.auth_events || "[]"),
          prev_events: JSON.parse(fullEvent.prev_events || "[]"),
          ...(fullEvent.hashes ? { hashes: JSON.parse(fullEvent.hashes) } : {}),
          ...(fullEvent.signatures ? { signatures: JSON.parse(fullEvent.signatures) } : {}),
        });
      }
      continue;
    }

    const event = await db
      .prepare(
        `SELECT e.event_type, e.state_key, e.content, e.sender
         FROM room_state rs
         JOIN events e ON rs.event_id = e.event_id
         WHERE rs.room_id = ? AND rs.event_type = ?`,
      )
      .bind(roomId, eventType)
      .first<{
        event_type: string;
        state_key: string;
        content: string;
        sender: string;
      }>();
    if (!event) {
      continue;
    }

    strippedState.push({
      type: event.event_type,
      state_key: event.state_key,
      content: JSON.parse(event.content),
      sender: event.sender,
    });
  }

  return c.json({ knock_room_state: strippedState });
});

app.put("/_matrix/federation/v1/exchange_third_party_invite/:roomId", async (c) => {
  const roomId = c.req.param("roomId");
  const validatedRoomId = toRoomId(roomId);
  if (!validatedRoomId) {
    return Errors.invalidParam("roomId", "Invalid room ID").toResponse();
  }
  const db = c.env.DB;
  const serverName = c.env.SERVER_NAME;

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  let validated: FederationThirdPartyInviteValidationResult;
  try {
    validated = await runDomainValidation(
      validateThirdPartyInviteExchangeRequest({ body, roomId: validatedRoomId }),
    );
  } catch (error) {
    const response = toFederationErrorResponse(error);
    if (response) {
      return response;
    }
    throw error;
  }

  const { mxid, token, signatures } = validated.signed;
  const sender = toUserId(validated.sender);
  const stateKey = toUserId(mxid);
  const validatedEventId = validated.eventId ? toEventId(validated.eventId) : null;
  if (!sender || !stateKey || (validated.eventId && !validatedEventId)) {
    return Errors.invalidParam("roomId", "Invalid third party invite identifiers").toResponse();
  }
  const room = await db
    .prepare(`SELECT room_id, room_version FROM rooms WHERE room_id = ?`)
    .bind(validatedRoomId)
    .first<{ room_id: string; room_version: string }>();
  if (!room) {
    return Errors.notFound("Room not found").toResponse();
  }

  const thirdPartyInviteEvent = await db
    .prepare(
      `SELECT e.event_id, e.content, e.sender, e.state_key
       FROM room_state rs
       JOIN events e ON rs.event_id = e.event_id
       WHERE rs.room_id = ? AND rs.event_type = 'm.room.third_party_invite' AND rs.state_key = ?`,
    )
    .bind(validatedRoomId, token)
    .first<{
      event_id: string;
      content: string;
      sender: string;
      state_key: string;
    }>();
  if (!thirdPartyInviteEvent) {
    return c.json(
      {
        errcode: "M_FORBIDDEN",
        error: "No third party invite found with matching token",
      },
      403,
    );
  }

  let inviteContent: {
    display_name?: string;
    key_validity_url?: string;
    public_key?: string;
    public_keys?: Array<{ public_key: string; key_validity_url?: string }>;
  };
  try {
    inviteContent = JSON.parse(thirdPartyInviteEvent.content);
  } catch {
    return c.json(
      {
        errcode: "M_INVALID_PARAM",
        error: "Invalid third party invite content",
      },
      400,
    );
  }

  const signedDataForVerification: Record<string, unknown> = {
    mxid,
    sender: thirdPartyInviteEvent.sender,
    token,
    signatures,
  };

  let signatureValid = false;
  const publicKeys = inviteContent.public_keys ?? [];
  if (inviteContent.public_key) {
    publicKeys.push({ public_key: inviteContent.public_key });
  }

  for (const keyInfo of publicKeys) {
    const publicKey = keyInfo.public_key;
    if (!publicKey) {
      continue;
    }

    for (const [signingServer, keySignatures] of Object.entries(signatures)) {
      for (const [keyId, signature] of Object.entries(keySignatures)) {
        if (!signature) {
          continue;
        }
        try {
          const isValid = await verifySignature(
            signedDataForVerification,
            signingServer,
            keyId,
            publicKey,
          );
          if (isValid) {
            signatureValid = true;
            break;
          }
        } catch (error) {
          console.warn(`Failed to verify signature from ${signingServer}:${keyId}:`, error);
        }
      }
      if (signatureValid) {
        break;
      }
    }
    if (signatureValid) {
      break;
    }
  }

  if (!signatureValid) {
    return c.json(
      {
        errcode: "M_FORBIDDEN",
        error: "Could not verify third party invite signature",
      },
      403,
    );
  }

  const key = await getServerSigningKey(db);
  if (!key) {
    return c.json(
      {
        errcode: "M_UNKNOWN",
        error: "Server signing key not configured",
      },
      500,
    );
  }

  const createEvent = await db
    .prepare(
      `SELECT e.event_id FROM room_state rs
       JOIN events e ON rs.event_id = e.event_id
       WHERE rs.room_id = ? AND rs.event_type = 'm.room.create'`,
    )
    .bind(roomId)
    .first<{ event_id: string }>();
  const joinRulesEvent = await db
    .prepare(
      `SELECT e.event_id FROM room_state rs
       JOIN events e ON rs.event_id = e.event_id
       WHERE rs.room_id = ? AND rs.event_type = 'm.room.join_rules'`,
    )
    .bind(roomId)
    .first<{ event_id: string }>();
  const powerLevelsEvent = await db
    .prepare(
      `SELECT e.event_id FROM room_state rs
       JOIN events e ON rs.event_id = e.event_id
       WHERE rs.room_id = ? AND rs.event_type = 'm.room.power_levels'`,
    )
    .bind(roomId)
    .first<{ event_id: string }>();
  const senderMembershipEvent = await db
    .prepare(
      `SELECT e.event_id FROM room_state rs
       JOIN events e ON rs.event_id = e.event_id
       WHERE rs.room_id = ? AND rs.event_type = 'm.room.member' AND rs.state_key = ?`,
    )
    .bind(roomId, validated.sender)
    .first<{ event_id: string }>();

  const authEvents: EventId[] = [];
  for (const candidate of [createEvent, joinRulesEvent, powerLevelsEvent, senderMembershipEvent]) {
    if (!candidate) continue;
    const eventId = toEventId(candidate.event_id);
    if (eventId) {
      authEvents.push(eventId);
    }
  }
  const thirdPartyInviteEventId = toEventId(thirdPartyInviteEvent.event_id);
  if (thirdPartyInviteEventId) {
    authEvents.push(thirdPartyInviteEventId);
  }

  const latestEvent = await db
    .prepare(`SELECT event_id, depth FROM events WHERE room_id = ? ORDER BY depth DESC LIMIT 1`)
    .bind(validatedRoomId)
    .first<{ event_id: string; depth: number }>();
  const prevEventId = latestEvent ? toEventId(latestEvent.event_id) : null;
  const prevEvents: EventId[] = prevEventId ? [prevEventId] : [];
  const depth = (latestEvent?.depth ?? 0) + 1;
  const originServerTs = Date.now();

  const inviteEvent = {
    room_id: validatedRoomId,
    sender,
    type: "m.room.member",
    state_key: stateKey,
    content: {
      membership: "invite",
      third_party_invite: {
        display_name: inviteContent.display_name ?? validated.displayName,
        signed: validated.signed,
      },
    },
    origin_server_ts: originServerTs,
    depth,
    auth_events: authEvents,
    prev_events: prevEvents,
  };

  const eventIdHash = await sha256(JSON.stringify({ ...inviteEvent, origin: serverName }));
  const eventId = validatedEventId ?? `$${eventIdHash}`;

  const signedEvent = await signJson(
    { ...inviteEvent, event_id: eventId },
    serverName,
    key.keyId,
    key.privateKeyJwk,
  );

  try {
    const storedPdu: PDU = {
      event_id: eventId,
      room_id: validatedRoomId,
      sender,
      type: "m.room.member",
      state_key: stateKey,
      content: inviteEvent.content,
      origin_server_ts: originServerTs,
      depth,
      auth_events: authEvents,
      prev_events: prevEvents,
      signatures: (signedEvent as any).signatures,
    };
    await persistFederationMembershipEvent(db, {
      roomId: validatedRoomId,
      event: storedPdu,
      source: "federation",
    });

    await db
      .prepare(
        `DELETE FROM room_state
         WHERE room_id = ? AND event_type = 'm.room.third_party_invite' AND state_key = ?`,
      )
      .bind(validatedRoomId, token)
      .run();
  } catch (error) {
    console.error("Failed to store third party invite exchange event:", error);
    return c.json(
      {
        errcode: "M_UNKNOWN",
        error: "Failed to store invite event",
      },
      500,
    );
  }

  return c.json({});
});

export default app;
