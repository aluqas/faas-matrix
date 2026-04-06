// Device Management API
// Implements: https://spec.matrix.org/v1.12/client-server-api/#device-management
//
// Manages user devices for E2EE and session management.

import { Hono } from "hono";
import type { AppEnv, Env } from "../types";
import { Errors } from "../utils/errors";
import { requireAuth } from "../middleware/auth";
import { verifyPassword } from "../utils/crypto";
import { deleteDevice as deleteStoredDevice } from "../services/database";
import { recordDeviceKeyChange } from "../services/device-key-changes";
import { publishDeviceListUpdateToSharedServers } from "../matrix/application/features/device-lists/command";
import { getSharedServersInRoomsWithUserIncludingPartialState } from "../matrix/application/features/partial-state/shared-servers";
import { queueFederationEdu } from "../matrix/application/features/shared/federation-edu-queue";
import type { DeviceKeysPayload } from "../types/client";
import { parseDeviceKeysPayload } from "./keys-contracts";

const app = new Hono<AppEnv>();

function getUserKeysDO(env: Env, userId: string): DurableObjectStub {
  const id = env.USER_KEYS.idFromName(userId);
  return env.USER_KEYS.get(id);
}

async function getStoredDeviceKeys(
  env: Env,
  userId: string,
  deviceId: string,
): Promise<DeviceKeysPayload | null> {
  const stub = getUserKeysDO(env, userId);
  const response = await stub.fetch(
    new Request(`http://internal/device-keys/get?device_id=${encodeURIComponent(deviceId)}`),
  );
  if (!response.ok) {
    return null;
  }

  return parseDeviceKeysPayload(await response.json().catch(() => null));
}

async function putStoredDeviceKeys(
  env: Env,
  userId: string,
  deviceId: string,
  keys: DeviceKeysPayload,
): Promise<void> {
  const stub = getUserKeysDO(env, userId);
  const response = await stub.fetch(
    new Request("http://internal/device-keys/put", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_id: deviceId, keys }),
    }),
  );
  if (!response.ok) {
    const errorText = await response.text().catch(() => "unknown error");
    throw new Error(`Failed to store device keys in DO: ${response.status} ${errorText}`);
  }

  await env.DEVICE_KEYS.put(`device:${userId}:${deviceId}`, JSON.stringify(keys));
}

function withUpdatedDisplayName(
  keys: DeviceKeysPayload,
  displayName: string | null | undefined,
): DeviceKeysPayload {
  const nextUnsigned = { ...keys.unsigned };
  if (typeof displayName === "string" && displayName.length > 0) {
    nextUnsigned["device_display_name"] = displayName;
  } else {
    delete nextUnsigned["device_display_name"];
  }

  return {
    ...keys,
    unsigned: nextUnsigned,
  };
}

function buildPasswordUiaResponse(session: string, error?: string) {
  return {
    flows: [{ stages: ["m.login.password"] }],
    params: {},
    session,
    ...(error
      ? {
          errcode: "M_FORBIDDEN" as const,
          error,
        }
      : {}),
  };
}

// ============================================
// Endpoints
// ============================================

// GET /_matrix/client/v3/devices - List all devices
app.get("/_matrix/client/v3/devices", requireAuth(), async (c) => {
  const userId = c.get("userId");
  const db = c.env.DB;

  const devices = await db
    .prepare(`
    SELECT device_id, display_name, last_seen_ts, last_seen_ip
    FROM devices
    WHERE user_id = ?
  `)
    .bind(userId)
    .all<{
      device_id: string;
      display_name: string | null;
      last_seen_ts: number | null;
      last_seen_ip: string | null;
    }>();

  return c.json({
    devices: devices.results.map((d) => ({
      device_id: d.device_id,
      display_name: d.display_name || undefined,
      last_seen_ts: d.last_seen_ts || undefined,
      last_seen_ip: d.last_seen_ip || undefined,
    })),
  });
});

// GET /_matrix/client/v3/devices/:deviceId - Get a specific device
app.get("/_matrix/client/v3/devices/:deviceId", requireAuth(), async (c) => {
  const userId = c.get("userId");
  const deviceId = c.req.param("deviceId");
  const db = c.env.DB;

  const device = await db
    .prepare(`
    SELECT device_id, display_name, last_seen_ts, last_seen_ip
    FROM devices
    WHERE user_id = ? AND device_id = ?
  `)
    .bind(userId, deviceId)
    .first<{
      device_id: string;
      display_name: string | null;
      last_seen_ts: number | null;
      last_seen_ip: string | null;
    }>();

  if (!device) {
    return Errors.notFound("Device not found").toResponse();
  }

  return c.json({
    device_id: device.device_id,
    display_name: device.display_name || undefined,
    last_seen_ts: device.last_seen_ts || undefined,
    last_seen_ip: device.last_seen_ip || undefined,
  });
});

// PUT /_matrix/client/v3/devices/:deviceId - Update device info
app.put("/_matrix/client/v3/devices/:deviceId", requireAuth(), async (c) => {
  const userId = c.get("userId");
  const deviceId = c.req.param("deviceId");
  const db = c.env.DB;

  let body: { display_name?: string };
  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  // Check device exists and belongs to user
  const device = await db
    .prepare(`
    SELECT device_id FROM devices WHERE user_id = ? AND device_id = ?
  `)
    .bind(userId, deviceId)
    .first();

  if (!device) {
    return Errors.notFound("Device not found").toResponse();
  }

  // Update display name if provided
  if (body.display_name !== undefined) {
    await db
      .prepare(`
      UPDATE devices SET display_name = ? WHERE user_id = ? AND device_id = ?
    `)
      .bind(body.display_name, userId, deviceId)
      .run();

    let deviceKeys: DeviceKeysPayload | null = null;
    try {
      const existingKeys = await getStoredDeviceKeys(c.env, userId, deviceId);
      if (existingKeys) {
        deviceKeys = withUpdatedDisplayName(existingKeys, body.display_name);
        await putStoredDeviceKeys(c.env, userId, deviceId, deviceKeys);
      }
    } catch (error) {
      console.error("[devices] failed to update stored device keys", error);
    }

    await recordDeviceKeyChange(db, userId, deviceId, "update");

    try {
      await publishDeviceListUpdateToSharedServers(
        {
          userId,
          deviceId,
          deviceDisplayName: typeof body.display_name === "string" ? body.display_name : undefined,
          keys: deviceKeys,
        },
        {
          localServerName: c.env.SERVER_NAME,
          now: () => Date.now(),
          getSharedRemoteServers: (sharedUserId) =>
            getSharedServersInRoomsWithUserIncludingPartialState(db, c.env.CACHE, sharedUserId),
          queueEdu: (destination, eduType, content) =>
            queueFederationEdu(c.env, destination, eduType, content),
        },
      );
    } catch (error) {
      console.error("[devices] failed to publish device list update", error);
    }
  }

  return c.json({});
});

// DELETE /_matrix/client/v3/devices/:deviceId - Delete a device
app.delete("/_matrix/client/v3/devices/:deviceId", requireAuth(), async (c) => {
  const userId = c.get("userId");
  const deviceId = c.req.param("deviceId");
  // Note: currentDeviceId could be used to prevent self-deletion in future
  void c.get("deviceId");
  const db = c.env.DB;

  // Check device exists and belongs to user
  const device = await db
    .prepare(`
    SELECT device_id FROM devices WHERE user_id = ? AND device_id = ?
  `)
    .bind(userId, deviceId)
    .first();

  if (!device) {
    return Errors.notFound("Device not found").toResponse();
  }

  // Try to get auth from body for UIA
  let auth:
    | {
        type?: string;
        password?: string;
        session?: string;
        identifier?: { type?: string; user?: string };
      }
    | undefined;
  try {
    const body = await c.req.json();
    auth = body.auth;
  } catch {
    // No auth provided
  }

  // If no auth provided, return UIA response
  if (!auth) {
    const sessionId = crypto.randomUUID();
    return c.json(buildPasswordUiaResponse(sessionId), 401);
  }

  // Verify password if auth provided
  if (auth.type === "m.login.password") {
    if (auth.identifier?.type === "m.id.user" && auth.identifier.user !== userId) {
      return Errors.forbidden("Authenticated user does not own this device").toResponse();
    }

    const user = await db
      .prepare(`
      SELECT password_hash FROM users WHERE user_id = ?
    `)
      .bind(userId)
      .first<{ password_hash: string }>();

    if (!user || !auth.password) {
      const sessionId = auth.session || crypto.randomUUID();
      return c.json(buildPasswordUiaResponse(sessionId, "Invalid password"), 401);
    }

    const valid = await verifyPassword(auth.password, user.password_hash);
    if (!valid) {
      const sessionId = auth.session || crypto.randomUUID();
      return c.json(buildPasswordUiaResponse(sessionId, "Invalid password"), 401);
    }
  }

  // Delete the device and its access tokens
  await db
    .prepare(`
    DELETE FROM access_tokens WHERE user_id = ? AND device_id = ?
  `)
    .bind(userId, deviceId)
    .run();
  await deleteStoredDevice(db, userId, deviceId);

  return c.json({});
});

// POST /_matrix/client/v3/delete_devices - Delete multiple devices
app.post("/_matrix/client/v3/delete_devices", requireAuth(), async (c) => {
  const userId = c.get("userId");
  const db = c.env.DB;

  let body: {
    devices: string[];
    auth?: {
      type?: string;
      password?: string;
      session?: string;
      identifier?: { type?: string; user?: string };
    };
  };
  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  if (!body.devices || !Array.isArray(body.devices)) {
    return Errors.missingParam("devices").toResponse();
  }

  // If no auth provided, return UIA response
  if (!body.auth) {
    const sessionId = crypto.randomUUID();
    return c.json(buildPasswordUiaResponse(sessionId), 401);
  }

  // Verify password if auth provided
  if (body.auth.type === "m.login.password") {
    if (body.auth.identifier?.type === "m.id.user" && body.auth.identifier.user !== userId) {
      return Errors.forbidden("Authenticated user does not own these devices").toResponse();
    }

    const user = await db
      .prepare(`
      SELECT password_hash FROM users WHERE user_id = ?
    `)
      .bind(userId)
      .first<{ password_hash: string }>();

    if (!user || !body.auth.password) {
      const sessionId = body.auth.session || crypto.randomUUID();
      return c.json(buildPasswordUiaResponse(sessionId, "Invalid password"), 401);
    }

    const valid = await verifyPassword(body.auth.password, user.password_hash);
    if (!valid) {
      const sessionId = body.auth.session || crypto.randomUUID();
      return c.json(buildPasswordUiaResponse(sessionId, "Invalid password"), 401);
    }
  }

  // Delete each device
  for (const deviceId of body.devices) {
    await db
      .prepare(`
      DELETE FROM access_tokens WHERE user_id = ? AND device_id = ?
    `)
      .bind(userId, deviceId)
      .run();
    await deleteStoredDevice(db, userId, deviceId);
  }

  return c.json({});
});

export default app;
