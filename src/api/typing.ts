// Typing Indicators API

import { Effect } from "effect";
import { Hono } from "hono";
import type { AppEnv } from "../shared/types";
import { Errors, MatrixApiError } from "../shared/utils/errors";
import { requireAuth } from "../infra/middleware/auth";
import { runClientEffect } from "../matrix/application/runtime/effect-runtime";
import { setTypingEffect } from "../features/typing/command";
import { decodeSetTypingInput } from "../features/typing/decode";
import { createTypingRequestPorts } from "../features/typing/effect-adapters";

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

app.put("/_matrix/client/v3/rooms/:roomId/typing/:userId", requireAuth(), async (c) => {
  const body = await parseRequiredJsonBody(c);
  if (!body.ok) {
    return body.response;
  }

  return respondWithClientEffect(
    decodeSetTypingInput({
      authUserId: c.get("userId"),
      roomId: decodeURIComponent(c.req.param("roomId")),
      targetUserId: decodeURIComponent(c.req.param("userId")),
      body: body.body,
    }).pipe(
      Effect.flatMap((input) =>
        setTypingEffect(
          createTypingRequestPorts(
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

export default app;
