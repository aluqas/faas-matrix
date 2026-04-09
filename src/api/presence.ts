// Presence API
// Implements: https://spec.matrix.org/v1.12/client-server-api/#presence

import { Effect } from "effect";
import { Hono } from "hono";
import type { AppEnv } from "../shared/types";
import { Errors, MatrixApiError } from "../shared/utils/errors";
import { requireAuth } from "../infra/middleware/auth";
import { runClientEffect } from "../matrix/application/runtime/effect-runtime";
import { setPresenceStatusEffect } from "../features/presence/command";
import {
  createPresenceCommandPorts,
  createPresenceQueryPorts,
} from "../features/presence/effect-adapters";
import {
  decodeGetPresenceStatusInput,
  decodeSetPresenceStatusInput,
} from "../features/presence/decode";
import { getPresenceStatusEffect } from "../features/presence/query";

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

async function parseRequiredJsonBody(
  c: import("hono").Context<AppEnv>,
): Promise<{ ok: true; body: unknown } | { ok: false; response: Response }> {
  try {
    return { ok: true, body: await c.req.json() };
  } catch {
    return { ok: false, response: Errors.badJson().toResponse() };
  }
}

app.put("/_matrix/client/v3/presence/:userId/status", requireAuth(), async (c) => {
  const body = await parseRequiredJsonBody(c);
  if (!body.ok) {
    return body.response;
  }

  return respondWithClientEffect(
    decodeSetPresenceStatusInput({
      authUserId: c.get("userId"),
      targetUserId: decodeURIComponent(c.req.param("userId")),
      body: body.body,
      now: Date.now(),
    }).pipe(
      Effect.flatMap((input) =>
        setPresenceStatusEffect(
          createPresenceCommandPorts(
            c.env,
            c.get("appContext").profile.name === "complement",
          ),
          input,
        ),
      ),
    ),
    () => c.json({}),
  );
});

app.get("/_matrix/client/v3/presence/:userId/status", requireAuth(), (c) => {
  return respondWithClientEffect(
    decodeGetPresenceStatusInput({
      targetUserId: decodeURIComponent(c.req.param("userId")),
    }).pipe(
      Effect.flatMap((input) =>
        getPresenceStatusEffect(createPresenceQueryPorts(c.env), input),
      ),
    ),
    (presenceRecord) =>
      c.json({
        presence: presenceRecord.presence,
        ...(presenceRecord.statusMsg !== undefined
          ? { status_msg: presenceRecord.statusMsg }
          : {}),
        ...(presenceRecord.lastActiveAgo !== undefined
          ? { last_active_ago: presenceRecord.lastActiveAgo }
          : {}),
        currently_active: presenceRecord.currentlyActive,
      }),
  );
});

export default app;
