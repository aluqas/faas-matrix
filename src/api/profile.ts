// Matrix profile endpoints

import { Effect } from "effect";
import { Hono } from "hono";
import type { AppEnv } from "../types";
import { Errors, MatrixApiError } from "../utils/errors";
import { requireAuth, optionalAuth } from "../middleware/auth";
import { runClientEffect } from "../matrix/application/effect-runtime";
import {
  deleteCustomProfileKeyEffect,
  putCustomProfileKeyEffect,
  updateProfileFieldEffect,
} from "../matrix/application/features/profile/command";
import {
  decodeDeleteCustomProfileKeyInput,
  decodeGetCustomProfileKeyInput,
  decodeProfileFieldUpdateInput,
  decodeProfileUserId,
  decodePutCustomProfileKeyInput,
} from "../matrix/application/features/profile/decode";
import {
  createProfileCommandPorts,
  createProfileQueryPorts,
} from "../matrix/application/features/profile/effect-adapters";
import {
  encodeEmptyProfileResponse,
  encodeProfileFieldResponse,
  encodeProfileResponseBody,
} from "../matrix/application/features/profile/encoder";
import {
  queryCustomProfileKeyEffect,
  queryProfileEffect,
} from "../matrix/application/features/profile/query";

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

async function decodeJsonBody(c: import("hono").Context<AppEnv>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }
}

// GET /_matrix/client/v3/profile/:userId - Get user profile
app.get("/_matrix/client/v3/profile/:userId", optionalAuth(), (c) => {
  return respondWithClientEffect(
      decodeProfileUserId(decodeURIComponent(c.req.param("userId"))).pipe(
      Effect.flatMap((userId) => queryProfileEffect(createProfileQueryPorts(c.env), { userId })),
    ),
    (profile) => c.json(encodeProfileResponseBody(profile)),
  );
});

// GET /_matrix/client/v3/profile/:userId/displayname - Get display name
app.get("/_matrix/client/v3/profile/:userId/displayname", optionalAuth(), (c) => {
  return respondWithClientEffect(
    decodeProfileUserId(decodeURIComponent(c.req.param("userId"))).pipe(
      Effect.flatMap((userId) =>
        queryProfileEffect(createProfileQueryPorts(c.env), {
          userId,
          field: "displayname",
        }),
      ),
    ),
    (profile) => c.json(encodeProfileFieldResponse("displayname", profile)),
  );
});

// PUT /_matrix/client/v3/profile/:userId/displayname - Set display name
app.put("/_matrix/client/v3/profile/:userId/displayname", requireAuth(), async (c) => {
  const body = await decodeJsonBody(c);
  if (body instanceof Response) {
    return body;
  }

  return respondWithClientEffect(
    decodeProfileFieldUpdateInput({
      authUserId: c.get("userId"),
      targetUserId: decodeURIComponent(c.req.param("userId")),
      field: "displayname",
      body,
    }).pipe(
      Effect.flatMap((input) => updateProfileFieldEffect(createProfileCommandPorts(c.env), input)),
    ),
    () => c.json(encodeEmptyProfileResponse()),
  );
});

// GET /_matrix/client/v3/profile/:userId/avatar_url - Get avatar URL
app.get("/_matrix/client/v3/profile/:userId/avatar_url", optionalAuth(), (c) => {
  return respondWithClientEffect(
    decodeProfileUserId(decodeURIComponent(c.req.param("userId"))).pipe(
      Effect.flatMap((userId) =>
        queryProfileEffect(createProfileQueryPorts(c.env), {
          userId,
          field: "avatar_url",
        }),
      ),
    ),
    (profile) => c.json(encodeProfileFieldResponse("avatar_url", profile)),
  );
});

// PUT /_matrix/client/v3/profile/:userId/avatar_url - Set avatar URL
app.put("/_matrix/client/v3/profile/:userId/avatar_url", requireAuth(), async (c) => {
  const body = await decodeJsonBody(c);
  if (body instanceof Response) {
    return body;
  }

  return respondWithClientEffect(
    decodeProfileFieldUpdateInput({
      authUserId: c.get("userId"),
      targetUserId: decodeURIComponent(c.req.param("userId")),
      field: "avatar_url",
      body,
    }).pipe(
      Effect.flatMap((input) => updateProfileFieldEffect(createProfileCommandPorts(c.env), input)),
    ),
    () => c.json(encodeEmptyProfileResponse()),
  );
});

// GET /_matrix/client/v3/profile/:userId/:keyName - Get custom profile key
app.get("/_matrix/client/v3/profile/:userId/:keyName", optionalAuth(), (c) => {
  const targetUserId = decodeURIComponent(c.req.param("userId"));
  const keyName = c.req.param("keyName");

  if (keyName === "displayname" || keyName === "avatar_url") {
    return c.json({ errcode: "M_UNRECOGNIZED", error: "Use specific endpoint" }, 400);
  }

  return respondWithClientEffect(
    decodeGetCustomProfileKeyInput({ targetUserId, keyName }).pipe(
      Effect.flatMap((input) => queryCustomProfileKeyEffect(createProfileQueryPorts(c.env), input)),
    ),
    (body) => c.json(body),
  );
});

// PUT /_matrix/client/v3/profile/:userId/:keyName - Set custom profile key
app.put("/_matrix/client/v3/profile/:userId/:keyName", requireAuth(), async (c) => {
  const body = await decodeJsonBody(c);
  if (body instanceof Response) {
    return body;
  }

  return respondWithClientEffect(
    decodePutCustomProfileKeyInput({
      authUserId: c.get("userId"),
      targetUserId: decodeURIComponent(c.req.param("userId")),
      keyName: c.req.param("keyName"),
      body,
    }).pipe(
      Effect.flatMap((input) => putCustomProfileKeyEffect(createProfileCommandPorts(c.env), input)),
    ),
    () => c.json(encodeEmptyProfileResponse()),
  );
});

// DELETE /_matrix/client/v3/profile/:userId/:keyName - Delete custom profile key
app.delete("/_matrix/client/v3/profile/:userId/:keyName", requireAuth(), (c) => {
  return respondWithClientEffect(
    decodeDeleteCustomProfileKeyInput({
      authUserId: c.get("userId"),
      targetUserId: decodeURIComponent(c.req.param("userId")),
      keyName: c.req.param("keyName"),
    }).pipe(
      Effect.flatMap((input) =>
        deleteCustomProfileKeyEffect(createProfileCommandPorts(c.env), input),
      ),
    ),
    () => c.json(encodeEmptyProfileResponse()),
  );
});

export default app;
