// Account data endpoints

import { Effect } from "effect";
import { Hono } from "hono";
import type { AppEnv } from "../types";
import { Errors, MatrixApiError } from "../utils/errors";
import { requireAuth } from "../middleware/auth";
import { runClientEffect } from "../matrix/application/effect-runtime";
import {
  deleteGlobalAccountDataEffect,
  deleteRoomAccountDataEffect,
  upsertGlobalAccountDataEffect,
  upsertRoomAccountDataEffect,
} from "../matrix/application/features/account-data/command";
import {
  decodeDeleteGlobalAccountDataInput,
  decodeDeleteRoomAccountDataInput,
  decodeGetGlobalAccountDataInput,
  decodeGetRoomAccountDataInput,
  decodePutGlobalAccountDataInput,
  decodePutRoomAccountDataInput,
} from "../matrix/application/features/account-data/decode";
import {
  createAccountDataCommandPorts,
  createAccountDataQueryPorts,
} from "../matrix/application/features/account-data/effect-adapters";
import {
  queryGlobalAccountDataEffect,
  queryRoomAccountDataEffect,
} from "../matrix/application/features/account-data/query";

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

async function decodeJsonBody(c: import("hono").Context<AppEnv>): Promise<unknown | Response> {
  try {
    return await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }
}

// GET /_matrix/client/v3/user/:userId/account_data/:type
app.get("/_matrix/client/v3/user/:userId/account_data/:type", requireAuth(), async (c) => {
  return respondWithClientEffect(
    decodeGetGlobalAccountDataInput({
      authUserId: c.get("userId"),
      targetUserId: decodeURIComponent(c.req.param("userId")),
      eventType: decodeURIComponent(c.req.param("type")),
    }).pipe(
      Effect.flatMap((input) =>
        queryGlobalAccountDataEffect(createAccountDataQueryPorts(c.env), input),
      ),
    ),
    (content) => c.json(content),
  );
});

// PUT /_matrix/client/v3/user/:userId/account_data/:type
app.put("/_matrix/client/v3/user/:userId/account_data/:type", requireAuth(), async (c) => {
  const body = await decodeJsonBody(c);
  if (body instanceof Response) {
    return body;
  }

  return respondWithClientEffect(
    decodePutGlobalAccountDataInput({
      authUserId: c.get("userId"),
      targetUserId: decodeURIComponent(c.req.param("userId")),
      eventType: decodeURIComponent(c.req.param("type")),
      body,
    }).pipe(
      Effect.flatMap((input) =>
        upsertGlobalAccountDataEffect(createAccountDataCommandPorts(c.env), input),
      ),
    ),
    () => c.json({}),
  );
});

// DELETE /_matrix/client/unstable/org.matrix.msc3391/user/:userId/account_data/:type
app.delete(
  "/_matrix/client/unstable/org.matrix.msc3391/user/:userId/account_data/:type",
  requireAuth(),
  async (c) => {
    return respondWithClientEffect(
      decodeDeleteGlobalAccountDataInput({
        authUserId: c.get("userId"),
        targetUserId: decodeURIComponent(c.req.param("userId")),
        eventType: decodeURIComponent(c.req.param("type")),
      }).pipe(
        Effect.flatMap((input) =>
          deleteGlobalAccountDataEffect(createAccountDataCommandPorts(c.env), input),
        ),
      ),
      () => c.json({}),
    );
  },
);

// ============================================
// Room Account Data
// ============================================

// GET /_matrix/client/v3/user/:userId/rooms/:roomId/account_data/:type
app.get(
  "/_matrix/client/v3/user/:userId/rooms/:roomId/account_data/:type",
  requireAuth(),
  async (c) => {
    return respondWithClientEffect(
      decodeGetRoomAccountDataInput({
        authUserId: c.get("userId"),
        targetUserId: decodeURIComponent(c.req.param("userId")),
        roomId: decodeURIComponent(c.req.param("roomId")),
        eventType: decodeURIComponent(c.req.param("type")),
      }).pipe(
        Effect.flatMap((input) =>
          queryRoomAccountDataEffect(createAccountDataQueryPorts(c.env), input),
        ),
      ),
      (content) => c.json(content),
    );
  },
);

// PUT /_matrix/client/v3/user/:userId/rooms/:roomId/account_data/:type
app.put(
  "/_matrix/client/v3/user/:userId/rooms/:roomId/account_data/:type",
  requireAuth(),
  async (c) => {
    const body = await decodeJsonBody(c);
    if (body instanceof Response) {
      return body;
    }

    return respondWithClientEffect(
      decodePutRoomAccountDataInput({
        authUserId: c.get("userId"),
        targetUserId: decodeURIComponent(c.req.param("userId")),
        roomId: decodeURIComponent(c.req.param("roomId")),
        eventType: decodeURIComponent(c.req.param("type")),
        body,
      }).pipe(
        Effect.flatMap((input) =>
          upsertRoomAccountDataEffect(createAccountDataCommandPorts(c.env), input),
        ),
      ),
      () => c.json({}),
    );
  },
);

// DELETE /_matrix/client/unstable/org.matrix.msc3391/user/:userId/rooms/:roomId/account_data/:type
app.delete(
  "/_matrix/client/unstable/org.matrix.msc3391/user/:userId/rooms/:roomId/account_data/:type",
  requireAuth(),
  async (c) => {
    return respondWithClientEffect(
      decodeDeleteRoomAccountDataInput({
        authUserId: c.get("userId"),
        targetUserId: decodeURIComponent(c.req.param("userId")),
        roomId: decodeURIComponent(c.req.param("roomId")),
        eventType: decodeURIComponent(c.req.param("type")),
      }).pipe(
        Effect.flatMap((input) =>
          deleteRoomAccountDataEffect(createAccountDataCommandPorts(c.env), input),
        ),
      ),
      () => c.json({}),
    );
  },
);

export default app;
