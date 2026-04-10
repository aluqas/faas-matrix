// To-Device Messages API
// Implements: https://spec.matrix.org/v1.12/client-server-api/#send-to-device-messaging

import { Effect } from "effect";
import { Hono } from "hono";
import type { AppEnv } from "../shared/types";
import { Errors, MatrixApiError } from "../shared/utils/errors";
import { requireAuth } from "../infra/middleware/auth";
import { runClientEffect } from "../matrix/application/runtime/effect-runtime";
import { sendToDeviceEffect } from "../features/to-device/command";
import { decodeSendToDeviceInput } from "../features/to-device/decode";
import { createToDeviceRequestPorts } from "../features/to-device/effect-adapters";

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

app.put("/_matrix/client/v3/sendToDevice/:eventType/:txnId", requireAuth(), async (c) => {
  const body = await decodeJsonBody(c);
  if (!body.ok) {
    return body.response;
  }

  return respondWithClientEffect(
    decodeSendToDeviceInput({
      authUserId: c.get("userId"),
      eventType: c.req.param("eventType"),
      txnId: c.req.param("txnId"),
      body: body.body,
    }).pipe(
      Effect.flatMap((input) =>
        sendToDeviceEffect(
          createToDeviceRequestPorts(c.env, c.get("appContext").profile.name === "complement"),
          input,
        ),
      ),
    ),
    (result) => c.json(result),
  );
});

export default app;
