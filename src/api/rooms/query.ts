import { Hono } from "hono";
import { Effect } from "effect";
import type { AppEnv } from "../../shared/types";
import { Errors } from "../../shared/utils/errors";
import { requireAuth } from "../../infra/middleware/auth";
import { runClientEffect } from "../../matrix/application/runtime/effect-runtime";
import type { RoomMessagesRelationFilter } from "../../matrix/application/room-query-service";
import { toEventId, toRoomId } from "../../shared/utils/ids";

const app = new Hono<AppEnv>();

function parseMessagesRelationFilter(
  rawFilter: string | undefined,
): RoomMessagesRelationFilter | null {
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

async function resolveRoomQueryEffect<A, E>(
  c: import("hono").Context<AppEnv>,
  effect: Effect.Effect<A, E>,
): Promise<Response> {
  try {
    return c.json(await runClientEffect(effect));
  } catch (error) {
    if (error instanceof Error && "toResponse" in error) {
      return (error as { toResponse(): Response }).toResponse();
    }
    throw error;
  }
}

function handleGetRoomStateEvent(
  c: import("hono").Context<AppEnv>,
  stateKey: string,
): Promise<Response> {
  const roomId = toRoomId(c.req.param("roomId"));
  if (!roomId) {
    return Promise.resolve(Errors.invalidParam("roomId", "Invalid room ID").toResponse());
  }
  return resolveRoomQueryEffect(
    c,
    c.get("appContext").services.roomQueries.getStateEvent({
      userId: c.get("userId"),
      roomId,
      eventType: c.req.param("eventType"),
      stateKey,
      formatEvent: c.req.query("format") === "event",
    }),
  );
}

function handleGetVisibleRoomEvent(c: import("hono").Context<AppEnv>): Promise<Response> {
  const roomId = toRoomId(c.req.param("roomId"));
  const eventId = toEventId(c.req.param("eventId"));
  if (!roomId || !eventId) {
    return Promise.resolve(Errors.invalidParam("roomId", "Invalid room or event ID").toResponse());
  }
  return resolveRoomQueryEffect(
    c,
    c.get("appContext").services.roomQueries.getVisibleEvent({
      userId: c.get("userId"),
      roomId,
      eventId,
    }),
  );
}

app.get("/_matrix/client/v3/rooms/:roomId/state", requireAuth(), (c) => {
  const roomId = toRoomId(c.req.param("roomId"));
  if (!roomId) {
    return Errors.invalidParam("roomId", "Invalid room ID").toResponse();
  }
  return resolveRoomQueryEffect(
    c,
    c.get("appContext").services.roomQueries.getCurrentState({
      userId: c.get("userId"),
      roomId,
    }),
  );
});

app.get("/_matrix/client/v3/rooms/:roomId/state/:eventType/:stateKey?", requireAuth(), (c) =>
  handleGetRoomStateEvent(c, c.req.param("stateKey") ?? ""),
);
app.get("/_matrix/client/v3/rooms/:roomId/state/:eventType/", requireAuth(), (c) =>
  handleGetRoomStateEvent(c, ""),
);

app.get("/_matrix/client/v3/rooms/:roomId/members", requireAuth(), (c) => {
  const roomId = toRoomId(c.req.param("roomId"));
  if (!roomId) {
    return Errors.invalidParam("roomId", "Invalid room ID").toResponse();
  }
  return resolveRoomQueryEffect(
    c,
    c.get("appContext").services.roomQueries.getMembers({
      userId: c.get("userId"),
      roomId,
    }),
  );
});

app.get("/_matrix/client/v3/rooms/:roomId/messages", requireAuth(), (c) => {
  let relationFilter: RoomMessagesRelationFilter | undefined;
  try {
    const parsedFilter = parseMessagesRelationFilter(c.req.query("filter"));
    if (parsedFilter === null) {
      return Errors.badJson().toResponse();
    }
    relationFilter = parsedFilter;
  } catch {
    return Errors.badJson().toResponse();
  }

  const limitParam = Number.parseInt(c.req.query("limit") ?? "10", 10);
  const limit = Number.isNaN(limitParam) ? 10 : Math.min(limitParam, 100);
  const roomId = toRoomId(c.req.param("roomId"));
  if (!roomId) {
    return Errors.invalidParam("roomId", "Invalid room ID").toResponse();
  }
  return resolveRoomQueryEffect(
    c,
    c.get("appContext").services.roomQueries.getMessages({
      userId: c.get("userId"),
      roomId,
      from: c.req.query("from"),
      dir: (c.req.query("dir") ?? "b") as "f" | "b",
      limit,
      relationFilter,
    }),
  );
});

app.get(
  "/_matrix/client/v3/rooms/:roomId/event/:eventId",
  requireAuth(),
  handleGetVisibleRoomEvent,
);
app.get(
  "/_matrix/client/r0/rooms/:roomId/event/:eventId",
  requireAuth(),
  handleGetVisibleRoomEvent,
);

app.get("/_matrix/client/v3/rooms/:roomId/timestamp_to_event", requireAuth(), (c) => {
  const tsParam = c.req.query("ts");
  const dirParam = c.req.query("dir");

  const roomId = toRoomId(c.req.param("roomId"));
  if (!tsParam) {
    return Errors.missingParam("ts").toResponse();
  }
  if (!dirParam) {
    return Errors.missingParam("dir").toResponse();
  }

  const ts = Number.parseInt(tsParam, 10);
  if (Number.isNaN(ts)) {
    return c.json(
      {
        errcode: "M_INVALID_PARAM",
        error: "ts must be a valid integer timestamp in milliseconds",
      },
      400,
    );
  }

  if (dirParam !== "f" && dirParam !== "b") {
    return c.json(
      {
        errcode: "M_INVALID_PARAM",
        error: "dir must be 'f' (forward) or 'b' (backward)",
      },
      400,
    );
  }

  if (!roomId) {
    return Errors.invalidParam("roomId", "Invalid room ID").toResponse();
  }

  return resolveRoomQueryEffect(
    c,
    c.get("appContext").services.roomQueries.getTimestampToEvent({
      userId: c.get("userId"),
      roomId,
      ts,
      dir: dirParam,
    }),
  );
});

export default app;
