import { Hono } from "hono";
import type { AppEnv } from "../../types";
import type { DeviceKeyRequestMap, OneTimeKeyClaimMap } from "../../types/client";
import { Errors } from "../../utils/errors";
import { getCrossSigningKeysFromDO, getDeviceKeysFromDO } from "./shared";

const app = new Hono<AppEnv>();

app.post("/_matrix/federation/v1/user/keys/query", async (c) => {
  const serverName = c.env.SERVER_NAME;
  const db = c.env.DB;

  let body: {
    device_keys?: DeviceKeyRequestMap;
  };

  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  const requestedKeys = body.device_keys;
  if (!requestedKeys || typeof requestedKeys !== "object") {
    return Errors.missingParam("device_keys").toResponse();
  }

  const deviceKeys: Record<string, Record<string, any>> = {};
  const masterKeys: Record<string, any> = {};
  const selfSigningKeys: Record<string, any> = {};

  async function mergeSignaturesForDevice(
    userId: string,
    deviceId: string,
    deviceKey: any,
  ): Promise<any> {
    const dbSignatures = await db
      .prepare(
        `SELECT signer_user_id, signer_key_id, signature
         FROM cross_signing_signatures
         WHERE user_id = ? AND key_id = ?`,
      )
      .bind(userId, deviceId)
      .all<{
        signer_user_id: string;
        signer_key_id: string;
        signature: string;
      }>();

    if (dbSignatures.results.length > 0) {
      deviceKey.signatures = deviceKey.signatures || {};
      for (const sig of dbSignatures.results) {
        deviceKey.signatures[sig.signer_user_id] = deviceKey.signatures[sig.signer_user_id] || {};
        deviceKey.signatures[sig.signer_user_id][sig.signer_key_id] = sig.signature;
      }
    }

    return deviceKey;
  }

  for (const [userId, requestedDevices] of Object.entries(requestedKeys)) {
    const userServerName = userId.split(":")[1];
    if (userServerName !== serverName) {
      continue;
    }

    const user = await db
      .prepare(`SELECT user_id FROM users WHERE user_id = ?`)
      .bind(userId)
      .first<{ user_id: string }>();
    if (!user) {
      continue;
    }

    deviceKeys[userId] = {};

    if (!requestedDevices || requestedDevices.length === 0) {
      const allDeviceKeys = await getDeviceKeysFromDO(c.env, userId);
      for (const [deviceId, keys] of Object.entries(allDeviceKeys)) {
        if (keys) {
          deviceKeys[userId][deviceId] = await mergeSignaturesForDevice(userId, deviceId, keys);
        }
      }
    } else {
      for (const deviceId of requestedDevices) {
        const keys = await getDeviceKeysFromDO(c.env, userId, deviceId);
        if (keys) {
          deviceKeys[userId][deviceId] = await mergeSignaturesForDevice(userId, deviceId, keys);
        }
      }
    }

    const csKeys = await getCrossSigningKeysFromDO(c.env, userId);
    if (csKeys.master) {
      masterKeys[userId] = csKeys.master;
    }
    if (csKeys.self_signing) {
      selfSigningKeys[userId] = csKeys.self_signing;
    }
  }

  return c.json({
    device_keys: deviceKeys,
    master_keys: masterKeys,
    self_signing_keys: selfSigningKeys,
  });
});

app.post("/_matrix/federation/v1/user/keys/claim", async (c) => {
  const serverName = c.env.SERVER_NAME;
  const db = c.env.DB;

  let body: {
    one_time_keys?: OneTimeKeyClaimMap;
  };

  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  const requestedKeys = body.one_time_keys;
  if (!requestedKeys || typeof requestedKeys !== "object") {
    return Errors.missingParam("one_time_keys").toResponse();
  }

  const oneTimeKeys: Record<string, Record<string, Record<string, any>>> = {};

  for (const [userId, devices] of Object.entries(requestedKeys)) {
    const userServerName = userId.split(":")[1];
    if (userServerName !== serverName) {
      continue;
    }

    oneTimeKeys[userId] = {};

    for (const [deviceId, algorithm] of Object.entries(devices)) {
      const existingKeys = (await c.env.ONE_TIME_KEYS.get(
        `otk:${userId}:${deviceId}`,
        "json",
      )) as Record<string, { keyId: string; keyData: any; claimed: boolean }[]> | null;

      let foundKey = false;

      if (existingKeys && existingKeys[algorithm]) {
        const keyIndex = existingKeys[algorithm].findIndex((key) => !key.claimed);
        if (keyIndex >= 0) {
          const key = existingKeys[algorithm][keyIndex];
          existingKeys[algorithm][keyIndex].claimed = true;

          await c.env.ONE_TIME_KEYS.put(`otk:${userId}:${deviceId}`, JSON.stringify(existingKeys));
          await db
            .prepare(
              `UPDATE one_time_keys SET claimed = 1, claimed_at = ?
               WHERE user_id = ? AND device_id = ? AND key_id = ?`,
            )
            .bind(Date.now(), userId, deviceId, key.keyId)
            .run();

          oneTimeKeys[userId][deviceId] = {
            [key.keyId]: key.keyData,
          };
          foundKey = true;
        }
      }

      if (!foundKey) {
        const otk = await db
          .prepare(
            `SELECT id, key_id, key_data FROM one_time_keys
             WHERE user_id = ? AND device_id = ? AND algorithm = ? AND claimed = 0
             LIMIT 1`,
          )
          .bind(userId, deviceId, algorithm)
          .first<{
            id: number;
            key_id: string;
            key_data: string;
          }>();

        if (otk) {
          await db
            .prepare(`UPDATE one_time_keys SET claimed = 1, claimed_at = ? WHERE id = ?`)
            .bind(Date.now(), otk.id)
            .run();

          oneTimeKeys[userId][deviceId] = {
            [otk.key_id]: JSON.parse(otk.key_data),
          };
          foundKey = true;
        }
      }

      if (!foundKey) {
        const fallback = await db
          .prepare(
            `SELECT key_id, key_data, used FROM fallback_keys
             WHERE user_id = ? AND device_id = ? AND algorithm = ?`,
          )
          .bind(userId, deviceId, algorithm)
          .first<{
            key_id: string;
            key_data: string;
            used: number;
          }>();

        if (fallback) {
          await db
            .prepare(
              `UPDATE fallback_keys SET used = 1
               WHERE user_id = ? AND device_id = ? AND algorithm = ?`,
            )
            .bind(userId, deviceId, algorithm)
            .run();

          const keyData = JSON.parse(fallback.key_data);
          oneTimeKeys[userId][deviceId] = {
            [fallback.key_id]: {
              ...keyData,
              fallback: true,
            },
          };
        }
      }
    }
  }

  return c.json({ one_time_keys: oneTimeKeys });
});

app.get("/_matrix/federation/v1/user/devices/:userId", async (c) => {
  const serverName = c.env.SERVER_NAME;
  const userId = c.req.param("userId");
  const db = c.env.DB;

  const userServerName = userId.split(":")[1];
  if (userServerName !== serverName) {
    return c.json(
      {
        errcode: "M_FORBIDDEN",
        error: "User is not local to this server",
      },
      403,
    );
  }

  const user = await db
    .prepare(`SELECT user_id FROM users WHERE user_id = ?`)
    .bind(userId)
    .first<{ user_id: string }>();
  if (!user) {
    return Errors.notFound("User not found").toResponse();
  }

  const dbDevices = await db
    .prepare(`SELECT device_id, display_name FROM devices WHERE user_id = ?`)
    .bind(userId)
    .all<{ device_id: string; display_name: string | null }>();
  const allDeviceKeys = await getDeviceKeysFromDO(c.env, userId);
  const streamPosition = await db
    .prepare(`SELECT MAX(stream_position) as stream_id FROM device_key_changes WHERE user_id = ?`)
    .bind(userId)
    .first<{ stream_id: number | null }>();

  const devices = dbDevices.results.map((device) => ({
    device_id: device.device_id,
    keys: allDeviceKeys[device.device_id] || undefined,
    device_display_name: device.display_name || undefined,
  }));

  const csKeys = await getCrossSigningKeysFromDO(c.env, userId);
  const response: any = {
    user_id: userId,
    stream_id: streamPosition?.stream_id || 0,
    devices,
  };

  if (csKeys.master) {
    response.master_key = csKeys.master;
  }
  if (csKeys.self_signing) {
    response.self_signing_key = csKeys.self_signing;
  }

  return c.json(response);
});

export default app;
