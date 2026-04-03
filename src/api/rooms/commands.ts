import { Hono } from "hono";
import type { AppEnv } from "../../types";
import { requireAuth } from "../../middleware/auth";
import {
  MAX_ROOM_EVENT_CONTENT_BYTES,
  parseRequiredJsonObjectBody,
  toRouteErrorResponse,
} from "./shared";

const app = new Hono<AppEnv>();

app.put("/_matrix/client/v3/rooms/:roomId/send/:eventType/:txnId", requireAuth(), async (c) => {
  try {
    const content = await parseRequiredJsonObjectBody(c, {
      maxBytes: MAX_ROOM_EVENT_CONTENT_BYTES,
    });
    const response = await c.get("appContext").services.rooms.sendEvent({
      userId: c.get("userId"),
      roomId: c.req.param("roomId"),
      eventType: c.req.param("eventType"),
      txnId: c.req.param("txnId"),
      content,
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

app.post("/_matrix/client/v3/rooms/:roomId/invite", requireAuth(), async (c) => {
  try {
    const body = await parseRequiredJsonObjectBody(c);
    await c.get("appContext").services.rooms.inviteRoom({
      userId: c.get("userId"),
      roomId: c.req.param("roomId"),
      targetUserId: body.user_id as string,
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

app.post("/_matrix/client/v3/rooms/:roomId/kick", requireAuth(), async (c) => {
  try {
    const body = await parseRequiredJsonObjectBody(c);
    await c.get("appContext").services.rooms.kickUser({
      userId: c.get("userId"),
      roomId: c.req.param("roomId"),
      targetUserId: body.user_id as string,
      reason: typeof body.reason === "string" ? body.reason : undefined,
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

app.post("/_matrix/client/v3/rooms/:roomId/ban", requireAuth(), async (c) => {
  try {
    const body = await parseRequiredJsonObjectBody(c);
    await c.get("appContext").services.rooms.banUser({
      userId: c.get("userId"),
      roomId: c.req.param("roomId"),
      targetUserId: body.user_id as string,
      reason: typeof body.reason === "string" ? body.reason : undefined,
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

app.post("/_matrix/client/v3/rooms/:roomId/unban", requireAuth(), async (c) => {
  try {
    const body = await parseRequiredJsonObjectBody(c);
    await c.get("appContext").services.rooms.unbanUser({
      userId: c.get("userId"),
      roomId: c.req.param("roomId"),
      targetUserId: body.user_id as string,
      reason: typeof body.reason === "string" ? body.reason : undefined,
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

export default app;
