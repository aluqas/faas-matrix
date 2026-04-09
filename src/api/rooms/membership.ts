import { Hono } from "hono";
import type { AppEnv } from "../../shared/types";
import { parseOptionalJsonObjectBody, resolveRoomIdOrAlias, toRouteErrorResponse } from "./shared";
import { requireAuth } from "../../infra/middleware/auth";
import { Errors } from "../../shared/utils/errors";
import { toRoomId } from "../../shared/utils/ids";

const app = new Hono<AppEnv>();

async function parseKnockBody(c: import("hono").Context<AppEnv>) {
  const parsed = await parseOptionalJsonObjectBody(c).catch(() => {});
  return {
    reason: typeof parsed?.reason === "string" ? parsed.reason : undefined,
    server_name: Array.isArray(parsed?.server_name)
      ? parsed.server_name.filter((value): value is string => typeof value === "string")
      : undefined,
  };
}

app.post("/_matrix/client/v3/rooms/:roomId/join", requireAuth(), async (c) => {
  try {
    const body = await parseOptionalJsonObjectBody(c);
    const roomId = toRoomId(c.req.param("roomId"));
    if (!roomId) {
      return Errors.invalidParam("roomId", "Invalid room ID").toResponse();
    }
    const response = await c.get("appContext").services.rooms.joinRoom({
      userId: c.get("userId"),
      roomId,
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

app.post("/_matrix/client/v3/rooms/:roomId/leave", requireAuth(), async (c) => {
  try {
    const roomId = toRoomId(c.req.param("roomId"));
    if (!roomId) {
      return Errors.invalidParam("roomId", "Invalid room ID").toResponse();
    }
    await c.get("appContext").services.rooms.leaveRoom({
      userId: c.get("userId"),
      roomId,
    });
    return c.json({});
  } catch (error) {
    const response = toRouteErrorResponse(error);
    if (response) {
      return response;
    }
    throw error;
  }
});

async function handleKnock(
  c: import("hono").Context<AppEnv>,
  roomId: import("../../shared/types").RoomId,
  reason?: string,
  serverNames?: string[],
): Promise<Response> {
  try {
    const response = await c.get("appContext").services.rooms.knockRoom({
      userId: c.get("userId"),
      roomId,
      reason,
      serverNames,
    });
    return c.json(response);
  } catch (error) {
    const response = toRouteErrorResponse(error);
    if (response) {
      return response;
    }
    throw error;
  }
}

app.post("/_matrix/client/v3/rooms/:roomId/knock", requireAuth(), async (c) => {
  const body = await parseKnockBody(c);
  const roomId = toRoomId(c.req.param("roomId"));
  if (!roomId) {
    return Errors.invalidParam("roomId", "Invalid room ID").toResponse();
  }
  return handleKnock(c, roomId, body.reason);
});

app.post("/_matrix/client/v3/knock/:roomIdOrAlias", requireAuth(), async (c) => {
  const body = await parseKnockBody(c);

  try {
    const resolved = await resolveRoomIdOrAlias(
      c,
      decodeURIComponent(c.req.param("roomIdOrAlias")),
      body.server_name ?? [],
    );
    return await handleKnock(c, resolved.roomId, body.reason, resolved.remoteServers);
  } catch (error) {
    const response = toRouteErrorResponse(error);
    if (response) {
      return response;
    }
    throw error;
  }
});

export default app;
