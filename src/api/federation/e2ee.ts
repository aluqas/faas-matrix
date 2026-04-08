import { Effect } from "effect";
import { Hono } from "hono";
import type { AppEnv } from "../../types";
import { Errors, MatrixApiError } from "../../utils/errors";
import { DomainError, toMatrixApiError } from "../../matrix/application/domain-error";
import { runFederationEffect } from "../../matrix/application/effect-runtime";
import { createFederationE2EEQueryPorts } from "../../matrix/application/features/federation/e2ee-effect-adapters";
import {
  claimFederationOneTimeKeysEffect,
  queryFederationDeviceKeysEffect,
  queryFederationUserDevicesEffect,
} from "../../matrix/application/features/federation/e2ee-query";
import {
  decodeFederationKeysClaimInput,
  decodeFederationKeysQueryInput,
  decodeFederationUserDevicesInput,
} from "../../matrix/application/features/federation/e2ee-decode";

const app = new Hono<AppEnv>();

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

async function decodeJsonBody(c: import("hono").Context<AppEnv>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }
}

function getFederationE2EEPorts(c: import("hono").Context<AppEnv>) {
  return createFederationE2EEQueryPorts({
    SERVER_NAME: c.env.SERVER_NAME,
    DB: c.env.DB,
    ONE_TIME_KEYS: c.env.ONE_TIME_KEYS,
    USER_KEYS: c.env.USER_KEYS,
  });
}

app.post("/_matrix/federation/v1/user/keys/query", async (c) => {
  const body = await decodeJsonBody(c);
  if (body instanceof Response) {
    return body;
  }

  return respondWithFederationEffect(
    decodeFederationKeysQueryInput(body).pipe(
      Effect.flatMap((input) => queryFederationDeviceKeysEffect(getFederationE2EEPorts(c), input)),
    ),
    (response) => c.json(response),
  );
});

app.post("/_matrix/federation/v1/user/keys/claim", async (c) => {
  const body = await decodeJsonBody(c);
  if (body instanceof Response) {
    return body;
  }

  return respondWithFederationEffect(
    decodeFederationKeysClaimInput(body).pipe(
      Effect.flatMap((input) => claimFederationOneTimeKeysEffect(getFederationE2EEPorts(c), input)),
    ),
    (response) => c.json(response),
  );
});

app.get("/_matrix/federation/v1/user/devices/:userId", (c) => {
  return respondWithFederationEffect(
    decodeFederationUserDevicesInput(c.req.param("userId")).pipe(
      Effect.flatMap((input) => queryFederationUserDevicesEffect(getFederationE2EEPorts(c), input)),
    ),
    (response) => c.json(response),
  );
});

export default app;
