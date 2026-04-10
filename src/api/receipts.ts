// Read Receipts API
// Implements: https://spec.matrix.org/v1.12/client-server-api/#receipts

import { Effect } from "effect";
import { Hono } from "hono";
import type { AppEnv } from "../shared/types";
import { Errors, MatrixApiError } from "../shared/utils/errors";
import { requireAuth } from "../infra/middleware/auth";
import { runClientEffect } from "../matrix/application/runtime/effect-runtime";
import { sendReceiptEffect, setReadMarkersEffect } from "../features/receipts/command";
import { decodeSendReceiptInput, decodeSetReadMarkersInput } from "../features/receipts/decode";
import { createReceiptsCommandPorts } from "../features/receipts/effect-adapters";

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

async function parseOptionalJsonBody(
  c: import("hono").Context<AppEnv>,
): Promise<{ ok: true; body?: unknown } | { ok: false; response: Response }> {
  try {
    return { ok: true, body: await c.req.json() };
  } catch {
    return { ok: true };
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

app.post(
  "/_matrix/client/v3/rooms/:roomId/receipt/:receiptType/:eventId",
  requireAuth(),
  async (c) => {
    const body = await parseOptionalJsonBody(c);
    if (!body.ok) {
      return body.response;
    }

    return respondWithClientEffect(
      decodeSendReceiptInput({
        authUserId: c.get("userId"),
        roomId: decodeURIComponent(c.req.param("roomId")),
        receiptType: c.req.param("receiptType"),
        eventId: decodeURIComponent(c.req.param("eventId")),
        body: body.body,
        now: Date.now(),
      }).pipe(
        Effect.flatMap((input) => sendReceiptEffect(createReceiptsCommandPorts(c.env), input)),
      ),
      () => c.json({}),
    );
  },
);

app.post("/_matrix/client/v3/rooms/:roomId/read_markers", requireAuth(), async (c) => {
  const body = await parseRequiredJsonBody(c);
  if (!body.ok) {
    return body.response;
  }

  return respondWithClientEffect(
    decodeSetReadMarkersInput({
      authUserId: c.get("userId"),
      roomId: decodeURIComponent(c.req.param("roomId")),
      body: body.body,
    }).pipe(
      Effect.flatMap((input) => setReadMarkersEffect(createReceiptsCommandPorts(c.env), input)),
    ),
    () => c.json({}),
  );
});

export default app;
