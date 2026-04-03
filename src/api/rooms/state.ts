import { Hono } from "hono";
import type { AppEnv, Membership } from "../../types";
import { Errors } from "../../utils/errors";
import { requireAuth } from "../../middleware/auth";
import { invalidateRoomCache } from "../../services/room-cache";
import { getEvent, getMembership, updateMembership } from "../../services/database";
import {
  isRecord,
  MAX_ROOM_EVENT_CONTENT_BYTES,
  parseRequiredJsonObjectBody,
  toRouteErrorResponse,
  validateCanonicalAliasContent,
} from "./shared";

const app = new Hono<AppEnv>();

const CACHED_STATE_TYPES = [
  "m.room.name",
  "m.room.avatar",
  "m.room.topic",
  "m.room.canonical_alias",
  "m.room.member",
];

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

  try {
    const content = await parseRequiredJsonObjectBody(c, {
      maxBytes: MAX_ROOM_EVENT_CONTENT_BYTES,
    });

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

    if (CACHED_STATE_TYPES.includes(eventType)) {
      invalidateRoomCache(c.env.CACHE, roomId).catch(() => {});
    }

    if (eventType === "m.room.member" && typeof content.membership === "string") {
      await updateMembership(
        c.env.DB,
        roomId,
        stateKey,
        content.membership as Membership,
        response.event_id,
        typeof content.displayname === "string" ? content.displayname : undefined,
        typeof content.avatar_url === "string" ? content.avatar_url : undefined,
      );
    }

    return c.json(response);
  } catch (error) {
    const response = toRouteErrorResponse(error);
    if (response) {
      return response;
    }
    throw error;
  }
}

app.put("/_matrix/client/v3/rooms/:roomId/state/:eventType/:stateKey?", requireAuth(), (c) =>
  putRoomStateEvent(c, c.req.param("stateKey") ?? ""),
);
app.put("/_matrix/client/v3/rooms/:roomId/state/:eventType/", requireAuth(), (c) =>
  putRoomStateEvent(c, ""),
);

app.put("/_matrix/client/v3/rooms/:roomId/redact/:eventId/:txnId", requireAuth(), async (c) => {
  const userId = c.get("userId");
  const roomId = c.req.param("roomId");
  const targetEventId = c.req.param("eventId");
  const txnId = c.req.param("txnId");

  const targetEvent = await getEvent(c.env.DB, targetEventId);
  if (targetEvent && targetEvent.room_id !== roomId) {
    return Errors.notFound("Event not found").toResponse();
  }

  let body: Record<string, unknown> | undefined;
  try {
    const parsed = await c.req.json();
    body = isRecord(parsed) ? parsed : undefined;
  } catch {
    body = undefined;
  }

  const redactionContent: Record<string, unknown> = {
    redacts: targetEventId,
  };
  if (typeof body?.reason === "string") {
    redactionContent.reason = body.reason;
  }

  try {
    const response = await c.get("appContext").services.rooms.sendEvent({
      userId,
      roomId,
      eventType: "m.room.redaction",
      txnId,
      content: redactionContent,
      redacts: targetEventId,
    });

    if (targetEvent) {
      await c.env.DB.prepare(`UPDATE events SET redacted_because = ? WHERE event_id = ?`)
        .bind(response.event_id, targetEventId)
        .run();
    }

    return c.json(response);
  } catch (error) {
    const response = toRouteErrorResponse(error);
    if (response) {
      return response;
    }
    throw error;
  }
});

export default app;
