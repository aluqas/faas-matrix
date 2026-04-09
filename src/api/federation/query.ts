import { Hono } from "hono";
import { Effect } from "effect";
import type { AppEnv } from "../../types";
import { Errors, MatrixApiError } from "../../utils/errors";
import { DomainError, toMatrixApiError } from "../../matrix/application/domain-error";
import { runFederationEffect } from "../../matrix/application/effect-runtime";
import {
  createFederationQueryPorts,
  queryFederationEventRelationshipsEffect,
  queryFederationProfileEffect,
  queryFederationServerKeysBatchEffect,
  queryFederationServerKeysEffect,
  resolveFederationDirectoryEffect,
} from "../../matrix/application/features/federation/query";
import {
  decodeFederationDirectoryQueryInput,
  decodeFederationEventRelationshipsInput,
  decodeFederationProfileQueryInput,
  decodeFederationServerKeysBatchQueryInput,
  decodeFederationServerKeysQueryInput,
} from "../../matrix/application/features/federation/query-decode";

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

app.post("/_matrix/key/v2/query", async (c) => {
  let body: unknown;

  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  return respondWithFederationEffect(
    decodeFederationServerKeysBatchQueryInput(body).pipe(
      Effect.flatMap((input) => queryFederationServerKeysBatchEffect(getFederationQueryPorts(c), input)),
    ),
    (results) => c.json({ server_keys: results }),
  );
});

app.on(["GET", "PUT", "DELETE", "PATCH"], "/_matrix/key/v2/query", () => methodNotAllowedJson());

app.get("/_matrix/key/v2/query/:serverName", (c) => {
  return respondWithFederationEffect(
    decodeFederationServerKeysQueryInput({
      serverName: c.req.param("serverName"),
      minimumValidUntilTs: c.req.query("minimum_valid_until_ts"),
    }).pipe(
      Effect.flatMap((input) => queryFederationServerKeysEffect(getFederationQueryPorts(c), input)),
    ),
    (keyResponses) => c.json({ server_keys: keyResponses }),
  );
});

app.get("/_matrix/key/v2/query/:serverName/:keyId", (c) => {
  return respondWithFederationEffect(
    decodeFederationServerKeysQueryInput({
      serverName: c.req.param("serverName"),
      keyId: c.req.param("keyId"),
      minimumValidUntilTs: c.req.query("minimum_valid_until_ts"),
    }).pipe(
      Effect.flatMap((input) => queryFederationServerKeysEffect(getFederationQueryPorts(c), input)),
    ),
    (keyResponses) => c.json({ server_keys: keyResponses }),
  );
});

app.get("/_matrix/federation/v1/query/directory", (c) => {
  return respondWithFederationEffect(
    decodeFederationDirectoryQueryInput({
      roomAlias: c.req.query("room_alias"),
    }).pipe(
      Effect.flatMap((input) => resolveFederationDirectoryEffect(getFederationQueryPorts(c), input)),
    ),
    (result) => c.json(result),
  );
});

app.get("/_matrix/federation/v1/query/profile", (c) => {
  return respondWithFederationEffect(
    decodeFederationProfileQueryInput({
      userId: c.req.query("user_id"),
      field: c.req.query("field"),
    }).pipe(
      Effect.flatMap((input) => queryFederationProfileEffect(getFederationQueryPorts(c), input)),
    ),
    (profile) => {
      const field = c.req.query("field");
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

  return respondWithFederationEffect(
    decodeFederationEventRelationshipsInput(body).pipe(
      Effect.flatMap((request) => queryFederationEventRelationshipsEffect(getFederationQueryPorts(c), request)),
    ),
    (result) => c.json(result),
  );
});

export default app;
