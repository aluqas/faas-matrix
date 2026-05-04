import { Hono } from "hono";
import type { PDU, RoomId } from "../../fatrix-model/types";
import type { AppEnv } from "../hono-env";
import { Errors } from "../../fatrix-model/utils/errors";
import { getPartialStateJoinForRoom } from "../../fatrix-backend/application/features/partial-state/tracker";
import { buildFederationMakeJoinTemplate } from "../../fatrix-backend/application/federation/membership/make-join";
import { processFederationSendJoin } from "../../fatrix-backend/application/federation/membership/send-join";
import { buildFederationMakeLeaveTemplate } from "../../fatrix-backend/application/federation/membership/make-leave";
import { processFederationSendLeave } from "../../fatrix-backend/application/federation/membership/send-leave";
import { processFederationInvite } from "../../fatrix-backend/application/federation/membership/invite";
import { buildFederationMakeKnockTemplate } from "../../fatrix-backend/application/federation/membership/make-knock";
import { processFederationSendKnock } from "../../fatrix-backend/application/federation/membership/send-knock";
import { exchangeFederationThirdPartyInvite } from "../../fatrix-backend/application/federation/membership/third-party-invite";
import { logFederationRouteWarning, toFederationErrorResponse } from "./shared";
import { toEventId, toRoomId, toUserId } from "../../fatrix-model/utils/ids";

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
    members_omitted: true as const,
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

  const result = await buildFederationMakeJoinTemplate({
    db: c.env.DB,
    roomId,
    userId,
  });
  if (result instanceof Response) {
    return result;
  }

  await logFederationRouteWarning(c, "make_join", {
    roomId,
    userId,
    roomVersion: result.roomVersion,
    currentMembership: result.currentMembership,
    currentMembershipEventId: result.currentMembershipEventId,
    currentStateMembership: result.currentStateMembership,
    currentStateMembershipEventId: result.currentStateMembershipEventId,
    authEvents: result.event.auth_events,
    prevEvents: result.event.prev_events,
    depth: result.event.depth,
  });

  return c.json({
    room_version: result.roomVersion,
    event: result.event,
  });
});

async function handleSendJoin(
  c: import("hono").Context<AppEnv>,
  version: "v1" | "v2",
): Promise<Response> {
  const roomId = toRoomId(c.req.param("roomId"));
  const eventId = toEventId(c.req.param("eventId"));
  if (!roomId || !eventId) {
    return Errors.invalidParam("roomId", "Invalid room or event ID").toResponse();
  }

  const omitMembers = c.req.query("omit_members") === "true";
  const origin = c.get("federationOrigin" as never) as string | undefined;
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
    return await processFederationSendJoin({
      env: c.env,
      roomId,
      eventId,
      body,
      origin,
      omitMembers,
      version,
      waitUntil: (promise) => {
        c.executionCtx.waitUntil(promise);
      },
      buildPartialResponse: buildPartialSendJoinResponse,
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
  const roomId = toRoomId(c.req.param("roomId"));
  const userId = toUserId(c.req.param("userId"));
  if (!roomId || !userId) {
    return Errors.invalidParam("roomId", "Invalid room or user ID").toResponse();
  }

  const result = await buildFederationMakeLeaveTemplate({
    db: c.env.DB,
    roomId,
    userId,
  });
  if (result instanceof Response) {
    return result;
  }

  await logFederationRouteWarning(c, "make_leave", {
    roomId,
    userId,
    roomVersion: result.roomVersion,
    currentMembership: result.currentMembership,
    currentMembershipEventId: result.currentMembershipEventId,
    currentStateMembership: result.currentStateMembership,
    currentStateMembershipEventId: result.currentStateMembershipEventId,
    authEvents: result.event.auth_events,
    prevEvents: result.event.prev_events,
    depth: result.event.depth,
  });

  return c.json({
    room_version: result.roomVersion,
    event: result.event,
  });
});

async function handleSendLeave(
  c: import("hono").Context<AppEnv>,
  version: "v1" | "v2",
): Promise<Response> {
  const roomId = toRoomId(c.req.param("roomId"));
  const eventId = toEventId(c.req.param("eventId"));
  const origin = c.get("federationOrigin" as never) as string | undefined;
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
    return await processFederationSendLeave({
      env: c.env,
      roomId,
      eventId,
      body,
      origin,
      version,
      waitUntil: (promise) => {
        c.executionCtx.waitUntil(promise);
      },
      envBindings: c.env,
    });
  } catch (error) {
    const response = toFederationErrorResponse(error);
    if (response) {
      return response;
    }
    throw error;
  }
}

app.put("/_matrix/federation/v1/send_leave/:roomId/:eventId", (c) => handleSendLeave(c, "v1"));
app.put("/_matrix/federation/v2/send_leave/:roomId/:eventId", (c) => handleSendLeave(c, "v2"));

async function handleFederationInvite(
  c: import("hono").Context<AppEnv>,
  version: "v1" | "v2",
): Promise<Response> {
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
    return await processFederationInvite({
      env: c.env,
      roomId,
      eventId,
      body,
      version,
      origin: c.get("federationOrigin" as never) as string | undefined,
    });
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

  const partialStateResponse = await ensureRoomNotPartiallyJoined(c, roomId);
  if (partialStateResponse) {
    return partialStateResponse;
  }

  const result = await buildFederationMakeKnockTemplate({
    db: c.env.DB,
    roomId,
    userId,
  });
  if (result instanceof Response) {
    return result;
  }

  return c.json({
    room_version: result.roomVersion,
    event: result.event,
  });
});

app.put("/_matrix/federation/v1/send_knock/:roomId/:eventId", async (c) => {
  const roomId = toRoomId(c.req.param("roomId"));
  const eventId = toEventId(c.req.param("eventId"));
  if (!roomId || !eventId) {
    return Errors.invalidParam("roomId", "Invalid room or event ID").toResponse();
  }

  const origin = c.get("federationOrigin" as never) as string | undefined;
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
    return await processFederationSendKnock({
      env: c.env,
      roomId,
      eventId,
      body,
      origin,
      waitUntil: (promise) => {
        c.executionCtx.waitUntil(promise);
      },
      envBindings: c.env,
    });
  } catch (error) {
    const response = toFederationErrorResponse(error);
    if (response) {
      return response;
    }
    throw error;
  }
});

app.put("/_matrix/federation/v1/exchange_third_party_invite/:roomId", async (c) => {
  const roomId = toRoomId(c.req.param("roomId"));
  if (!roomId) {
    return Errors.invalidParam("roomId", "Invalid room ID").toResponse();
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  try {
    return await exchangeFederationThirdPartyInvite({
      env: c.env,
      roomId,
      body,
    });
  } catch (error) {
    const response = toFederationErrorResponse(error);
    if (response) {
      return response;
    }
    throw error;
  }
});

export default app;
