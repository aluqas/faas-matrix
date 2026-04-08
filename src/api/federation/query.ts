import { Hono } from "hono";
import { Effect } from "effect";
import type { AppEnv } from "../../types";
import { Errors, MatrixApiError } from "../../utils/errors";
import { toEventId, toRoomId, toUserId } from "../../utils/ids";
import { DomainError, toMatrixApiError } from "../../matrix/application/domain-error";
import { runFederationEffect } from "../../matrix/application/effect-runtime";
import { type EventRelationshipsRequest } from "../../matrix/application/relationship-service";
import {
  createFederationQueryPorts,
  queryFederationEventRelationshipsEffect,
  queryFederationProfileEffect,
  queryFederationServerKeysBatchEffect,
  queryFederationServerKeysEffect,
  resolveFederationDirectoryEffect,
} from "../../matrix/application/features/federation/query";

const app = new Hono<AppEnv>();

function methodNotAllowedJson(): Response {
  return new Response(
    JSON.stringify({
      errcode: "M_UNRECOGNIZED",
      error: "Method not allowed",
    }),
    {
      status: 405,
      headers: {
        "Content-Type": "application/json",
      },
    },
  );
}

function toFederationErrorResponse(error: unknown): Response | null {
  if (error instanceof DomainError) {
    return toMatrixApiError(error).toResponse();
  }
  if (error instanceof MatrixApiError) {
    return error.toResponse();
  }
  return null;
}

async function respondWithFederationEffect<A>(
  effect: Effect.Effect<A, unknown>,
  respond: (value: A) => Response,
): Promise<Response> {
  try {
    return respond(await runFederationEffect(effect));
  } catch (error) {
    const response = toFederationErrorResponse(error);
    if (response) {
      return response;
    }
    throw error;
  }
}

function getFederationQueryPorts(c: {
  env: Pick<AppEnv["Bindings"], "SERVER_NAME" | "DB" | "CACHE">;
}) {
  return createFederationQueryPorts({
    localServerName: c.env.SERVER_NAME,
    db: c.env.DB,
    cache: c.env.CACHE,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseFederationEventRelationshipsRequest(
  input: unknown,
): EventRelationshipsRequest | null {
  if (!isRecord(input) || typeof input.event_id !== "string") {
    return null;
  }
  const eventId = toEventId(input.event_id);
  const roomId = typeof input.room_id === "string" ? toRoomId(input.room_id) : null;
  if (!eventId) {
    return null;
  }

  return {
    eventId,
    ...(roomId ? { roomId } : {}),
    direction: input.direction === "up" ? "up" : "down",
    ...(typeof input.include_parent === "boolean" ? { includeParent: input.include_parent } : {}),
    ...(typeof input.recent_first === "boolean" ? { recentFirst: input.recent_first } : {}),
    ...(typeof input.max_depth === "number" ? { maxDepth: input.max_depth } : {}),
  };
}

app.post("/_matrix/key/v2/query", async (c) => {
  let body: {
    server_keys?: Record<string, Record<string, { minimum_valid_until_ts?: number }>>;
  };

  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  const serverKeys = body.server_keys;
  if (!serverKeys || typeof serverKeys !== "object") {
    return Errors.missingParam("server_keys").toResponse();
  }

  return respondWithFederationEffect(
    queryFederationServerKeysBatchEffect(getFederationQueryPorts(c), {
      serverKeys,
    }),
    (results) => c.json({ server_keys: results }),
  );
});

app.on(["GET", "PUT", "DELETE", "PATCH"], "/_matrix/key/v2/query", () => methodNotAllowedJson());

app.get("/_matrix/key/v2/query/:serverName", (c) => {
  const serverName = c.req.param("serverName");
  const minimumValidUntilTs = Number.parseInt(c.req.query("minimum_valid_until_ts") ?? "0", 10);

  return respondWithFederationEffect(
    queryFederationServerKeysEffect(getFederationQueryPorts(c), {
      serverName,
      minimumValidUntilTs,
    }),
    (keyResponses) => c.json({ server_keys: keyResponses }),
  );
});

app.get("/_matrix/key/v2/query/:serverName/:keyId", (c) => {
  const serverName = c.req.param("serverName");
  const keyId = c.req.param("keyId");
  const minimumValidUntilTs = Number.parseInt(c.req.query("minimum_valid_until_ts") ?? "0", 10);

  return respondWithFederationEffect(
    queryFederationServerKeysEffect(getFederationQueryPorts(c), {
      serverName,
      keyId,
      minimumValidUntilTs,
    }),
    (keyResponses) => c.json({ server_keys: keyResponses }),
  );
});

app.get("/_matrix/federation/v1/query/directory", (c) => {
  const alias = c.req.query("room_alias");
  if (!alias) {
    return Errors.missingParam("room_alias").toResponse();
  }

  return respondWithFederationEffect(
    resolveFederationDirectoryEffect(getFederationQueryPorts(c), {
      roomAlias: alias,
    }),
    (result) => c.json(result),
  );
});

app.get("/_matrix/federation/v1/query/profile", (c) => {
  const rawUserId = c.req.query("user_id");
  const rawField = c.req.query("field");

  if (!rawUserId) {
    return Errors.missingParam("user_id").toResponse();
  }
  const userId = toUserId(rawUserId);
  if (!userId) {
    return Errors.invalidParam("user_id", "Invalid user ID").toResponse();
  }
  const field =
    rawField === undefined || rawField === "displayname" || rawField === "avatar_url"
      ? rawField
      : null;
  if (field === null) {
    return Errors.invalidParam("field", "Invalid profile field").toResponse();
  }

  return respondWithFederationEffect(
    queryFederationProfileEffect(getFederationQueryPorts(c), {
      userId,
      ...(field ? { field } : {}),
    }),
    (profile) => {
      if (field === "displayname") {
        return c.json({ displayname: profile.displayname });
      }
      if (field === "avatar_url") {
        return c.json({ avatar_url: profile.avatar_url });
      }
      return c.json(profile);
    },
  );
});

app.post("/_matrix/federation/unstable/event_relationships", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  const request = parseFederationEventRelationshipsRequest(body);
  if (!request) {
    return Errors.badJson().toResponse();
  }

  return respondWithFederationEffect(
    queryFederationEventRelationshipsEffect(getFederationQueryPorts(c), request),
    (result) => c.json(result),
  );
});

export default app;
