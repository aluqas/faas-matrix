// Device Management API

import { Effect } from "effect";
import { Hono } from "hono";
import type { AppEnv } from "../shared/types";
import { Errors, MatrixApiError } from "../shared/utils/errors";
import { requireAuth } from "../infra/middleware/auth";
import { runClientEffect } from "../matrix/application/runtime/effect-runtime";
import {
  decodeDeleteDeviceInput,
  decodeDeleteDevicesInput,
  decodeGetDeviceInput,
  decodeUpdateDeviceInput,
} from "../features/devices/decode";
import {
  deleteDeviceEffect,
  deleteDevicesEffect,
  updateDeviceDisplayNameEffect,
} from "../features/devices/command";
import {
  encodeDevice,
  encodeDeviceListResponse,
  encodeEmptyDeviceResponse,
  encodePasswordUiaResponse,
} from "../features/devices/encoder";
import { createDeviceCommandPorts, createDeviceQueryPorts } from "../features/devices/effect-adapters";
import { getDeviceEffect, listDevicesEffect } from "../features/devices/query";

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

async function parseOptionalJson(
  c: import("hono").Context<AppEnv>,
): Promise<{ ok: true; body?: unknown } | { ok: false; response: Response }> {
  try {
    return { ok: true, body: await c.req.json() };
  } catch {
    return { ok: true };
  }
}

async function parseRequiredJson(
  c: import("hono").Context<AppEnv>,
): Promise<{ ok: true; body: unknown } | { ok: false; response: Response }> {
  try {
    return { ok: true, body: await c.req.json() };
  } catch {
    return { ok: false, response: Errors.badJson().toResponse() };
  }
}

app.get("/_matrix/client/v3/devices", requireAuth(), (c) => {
  return respondWithClientEffect(
    listDevicesEffect(createDeviceQueryPorts(c.env), { authUserId: c.get("userId") }),
    (devices) => c.json(encodeDeviceListResponse(devices)),
  );
});

app.get("/_matrix/client/v3/devices/:deviceId", requireAuth(), (c) => {
  return respondWithClientEffect(
    decodeGetDeviceInput({
      authUserId: c.get("userId"),
      deviceId: c.req.param("deviceId"),
    }).pipe(Effect.flatMap((input) => getDeviceEffect(createDeviceQueryPorts(c.env), input))),
    (device) => c.json(encodeDevice(device)),
  );
});

app.put("/_matrix/client/v3/devices/:deviceId", requireAuth(), async (c) => {
  const body = await parseRequiredJson(c);
  if (!body.ok) {
    return body.response;
  }

  return respondWithClientEffect(
    decodeUpdateDeviceInput({
      authUserId: c.get("userId"),
      deviceId: c.req.param("deviceId"),
      body: body.body,
    }).pipe(
      Effect.flatMap((input) => updateDeviceDisplayNameEffect(createDeviceCommandPorts(c.env), input)),
    ),
    () => c.json(encodeEmptyDeviceResponse()),
  );
});

app.delete("/_matrix/client/v3/devices/:deviceId", requireAuth(), async (c) => {
  const parsed = await parseOptionalJson(c);
  if (!parsed.ok) {
    return parsed.response;
  }

  return respondWithClientEffect(
    decodeDeleteDeviceInput({
      authUserId: c.get("userId"),
      deviceId: c.req.param("deviceId"),
      body: parsed.body,
    }).pipe(Effect.flatMap((input) => deleteDeviceEffect(createDeviceCommandPorts(c.env), input))),
    (result) =>
      result.kind === "uia"
        ? c.json(encodePasswordUiaResponse(result.session, result.error), 401)
        : c.json(encodeEmptyDeviceResponse()),
  );
});

app.post("/_matrix/client/v3/delete_devices", requireAuth(), async (c) => {
  const body = await parseRequiredJson(c);
  if (!body.ok) {
    return body.response;
  }

  return respondWithClientEffect(
    decodeDeleteDevicesInput({
      authUserId: c.get("userId"),
      body: body.body,
    }).pipe(Effect.flatMap((input) => deleteDevicesEffect(createDeviceCommandPorts(c.env), input))),
    (result) =>
      result.kind === "uia"
        ? c.json(encodePasswordUiaResponse(result.session, result.error), 401)
        : c.json(encodeEmptyDeviceResponse()),
  );
});

export default app;
