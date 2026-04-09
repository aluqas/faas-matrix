// Relations and Threads API
// Implements: https://spec.matrix.org/v1.12/client-server-api/#aggregations-of-child-events

import { Effect } from "effect";
import { Hono } from "hono";
import type { AppEnv } from "../shared/types";
import { Errors, MatrixApiError } from "../shared/utils/errors";
import { requireAuth } from "../infra/middleware/auth";
import { runClientEffect } from "../matrix/application/runtime/effect-runtime";
import {
  decodeEventRelationshipsInput,
  decodeListRelationsInput,
  decodeListThreadsInput,
  decodePutThreadSubscriptionInput,
  decodeThreadSubscriptionTargetInput,
} from "../features/relations/decode";
import {
  encodeEmptyRelationsResponse,
  encodeEventRelationshipsResponse,
  encodeRelationChunkResponse,
  encodeThreadSubscriptionResponse,
} from "../features/relations/encoder";
import { createRelationsQueryPorts } from "../features/relations/effect-adapters";
import {
  deleteThreadSubscriptionEffect,
  getThreadSubscriptionEffect,
  listRelationEventsEffect,
  listThreadsEffect,
  putThreadSubscriptionEffect,
  queryEventRelationshipsEffect,
} from "../features/relations/query";

const app = new Hono<AppEnv>();

async function respondWithClientEffect<A>(
  effect: Effect.Effect<A, unknown>,
  respond: (value: A) => Response,
): Promise<Response> {
  try {
    return respond(await runClientEffect(effect));
  } catch (error) {
    if (error instanceof MatrixApiError) {
      return error.toResponse();
    }
    throw error;
  }
}

async function decodeJsonBody(
  c: import("hono").Context<AppEnv>,
): Promise<{ ok: true; body: unknown } | { ok: false; response: Response }> {
  try {
    return { ok: true, body: await c.req.json() };
  } catch {
    return { ok: false, response: Errors.badJson().toResponse() };
  }
}

app.post("/_matrix/client/unstable/event_relationships", requireAuth(), async (c) => {
  const body = await decodeJsonBody(c);
  if (!body.ok) {
    return body.response;
  }

  return respondWithClientEffect(
    decodeEventRelationshipsInput({
      authUserId: c.get("userId"),
      body: body.body,
    }).pipe(
      Effect.flatMap((input) =>
        queryEventRelationshipsEffect(createRelationsQueryPorts(c.env), input),
      ),
    ),
    (result) => c.json(encodeEventRelationshipsResponse(result)),
  );
});

app.get("/_matrix/client/v1/rooms/:roomId/relations/:eventId", requireAuth(), (c) => {
  return respondWithClientEffect(
    decodeListRelationsInput({
      authUserId: c.get("userId"),
      roomId: decodeURIComponent(c.req.param("roomId")),
      eventId: decodeURIComponent(c.req.param("eventId")),
      from: c.req.query("from"),
      limit: c.req.query("limit"),
      dir: c.req.query("dir"),
    }).pipe(
      Effect.flatMap((input) =>
        listRelationEventsEffect(createRelationsQueryPorts(c.env), input),
      ),
    ),
    (result) => c.json(encodeRelationChunkResponse(result)),
  );
});

app.get("/_matrix/client/v1/rooms/:roomId/relations/:eventId/:relType", requireAuth(), (c) => {
  return respondWithClientEffect(
    decodeListRelationsInput({
      authUserId: c.get("userId"),
      roomId: decodeURIComponent(c.req.param("roomId")),
      eventId: decodeURIComponent(c.req.param("eventId")),
      relType: decodeURIComponent(c.req.param("relType")),
      from: c.req.query("from"),
      limit: c.req.query("limit"),
      dir: c.req.query("dir"),
    }).pipe(
      Effect.flatMap((input) =>
        listRelationEventsEffect(createRelationsQueryPorts(c.env), input),
      ),
    ),
    (result) => c.json(encodeRelationChunkResponse(result)),
  );
});

app.get(
  "/_matrix/client/v1/rooms/:roomId/relations/:eventId/:relType/:eventType",
  requireAuth(),
  (c) => {
    return respondWithClientEffect(
      decodeListRelationsInput({
        authUserId: c.get("userId"),
        roomId: decodeURIComponent(c.req.param("roomId")),
        eventId: decodeURIComponent(c.req.param("eventId")),
        relType: decodeURIComponent(c.req.param("relType")),
        eventType: decodeURIComponent(c.req.param("eventType")),
        from: c.req.query("from"),
        limit: c.req.query("limit"),
        dir: c.req.query("dir"),
      }).pipe(
        Effect.flatMap((input) =>
          listRelationEventsEffect(createRelationsQueryPorts(c.env), input),
        ),
      ),
      (result) => c.json(encodeRelationChunkResponse(result)),
    );
  },
);

app.get("/_matrix/client/v1/rooms/:roomId/threads", requireAuth(), (c) => {
  return respondWithClientEffect(
    decodeListThreadsInput({
      authUserId: c.get("userId"),
      roomId: decodeURIComponent(c.req.param("roomId")),
      limit: c.req.query("limit"),
      include: c.req.query("include"),
    }).pipe(
      Effect.flatMap((input) => listThreadsEffect(createRelationsQueryPorts(c.env), input)),
    ),
    (result) => c.json(encodeRelationChunkResponse(result)),
  );
});

app.put(
  "/_matrix/client/unstable/io.element.msc4306/rooms/:roomId/thread/:threadRootId/subscription",
  requireAuth(),
  async (c) => {
    const body = await decodeJsonBody(c);
    if (!body.ok) {
      return body.response;
    }

    return respondWithClientEffect(
      decodePutThreadSubscriptionInput({
        authUserId: c.get("userId"),
        roomId: decodeURIComponent(c.req.param("roomId")),
        threadRootId: decodeURIComponent(c.req.param("threadRootId")),
        body: body.body,
      }).pipe(
        Effect.flatMap((input) =>
          putThreadSubscriptionEffect(createRelationsQueryPorts(c.env), input),
        ),
      ),
      () => c.json(encodeEmptyRelationsResponse()),
    );
  },
);

app.get(
  "/_matrix/client/unstable/io.element.msc4306/rooms/:roomId/thread/:threadRootId/subscription",
  requireAuth(),
  (c) => {
    return respondWithClientEffect(
      decodeThreadSubscriptionTargetInput({
        authUserId: c.get("userId"),
        roomId: decodeURIComponent(c.req.param("roomId")),
        threadRootId: decodeURIComponent(c.req.param("threadRootId")),
      }).pipe(
        Effect.flatMap((input) =>
          getThreadSubscriptionEffect(createRelationsQueryPorts(c.env), input),
        ),
      ),
      (result) => c.json(encodeThreadSubscriptionResponse(result)),
    );
  },
);

app.delete(
  "/_matrix/client/unstable/io.element.msc4306/rooms/:roomId/thread/:threadRootId/subscription",
  requireAuth(),
  (c) => {
    return respondWithClientEffect(
      decodeThreadSubscriptionTargetInput({
        authUserId: c.get("userId"),
        roomId: decodeURIComponent(c.req.param("roomId")),
        threadRootId: decodeURIComponent(c.req.param("threadRootId")),
      }).pipe(
        Effect.flatMap((input) =>
          deleteThreadSubscriptionEffect(createRelationsQueryPorts(c.env), input),
        ),
      ),
      () => c.json(encodeEmptyRelationsResponse()),
    );
  },
);

export default app;
