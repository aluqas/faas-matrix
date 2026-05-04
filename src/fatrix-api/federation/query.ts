import { Hono } from "hono";
import { Effect } from "effect";
import type { AppEnv } from "../hono-env";
import { Errors, MatrixApiError } from "../../fatrix-model/utils/errors";
import { DomainError, toMatrixApiError } from "../../fatrix-backend/application/domain-error";
import { runFederationEffect } from "../../fatrix-backend/application/runtime/effect-runtime";
import {
  queryFederationEventRelationshipsEffect,
  queryFederationProfileEffect,
  queryFederationServerKeysBatchEffect,
  queryFederationServerKeysEffect,
  resolveFederationDirectoryEffect,
} from "../../fatrix-backend/application/federation/query/query";
import { createFederationQueryPorts } from "../../platform/cloudflare/adapters/application-ports/federation-query/query-ports";
import {
  decodeFederationDirectoryQueryInput,
  decodeFederationEventRelationshipsInput,
  decodeFederationProfileQueryInput,
  decodeFederationServerKeysBatchQueryInput,
  decodeFederationServerKeysQueryInput,
} from "../../fatrix-backend/application/federation/query/query-decode";
import {
  encodeFederationProfileResponse,
  encodeFederationServerKeysResponse,
} from "../../fatrix-backend/application/federation/query/query-encoder";

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
      Effect.flatMap((input) =>
        queryFederationServerKeysBatchEffect(getFederationQueryPorts(c), input),
      ),
    ),
    (results) => c.json(encodeFederationServerKeysResponse(results)),
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
    (keyResponses) => c.json(encodeFederationServerKeysResponse(keyResponses)),
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
    (keyResponses) => c.json(encodeFederationServerKeysResponse(keyResponses)),
  );
});

app.get("/_matrix/federation/v1/query/directory", (c) => {
  return respondWithFederationEffect(
    decodeFederationDirectoryQueryInput({
      roomAlias: c.req.query("room_alias"),
    }).pipe(
      Effect.flatMap((input) =>
        resolveFederationDirectoryEffect(getFederationQueryPorts(c), input),
      ),
    ),
    (result) => c.json(result),
  );
});

app.get("/_matrix/federation/v1/query/profile", (c) => {
  const field = c.req.query("field");
  const encodedField = field === "displayname" || field === "avatar_url" ? field : undefined;

  return respondWithFederationEffect(
    decodeFederationProfileQueryInput({
      userId: c.req.query("user_id"),
      field,
    }).pipe(
      Effect.flatMap((input) => queryFederationProfileEffect(getFederationQueryPorts(c), input)),
    ),
    (profile) => c.json(encodeFederationProfileResponse(profile, encodedField)),
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
      Effect.flatMap((request) =>
        queryFederationEventRelationshipsEffect(getFederationQueryPorts(c), request),
      ),
    ),
    (result) => c.json(result),
  );
});

export default app;
