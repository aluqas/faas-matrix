// To-Device Messages API
// Implements: https://spec.matrix.org/v1.12/client-server-api/#send-to-device-messaging
//
// To-device messages are used for:
// - E2E encryption key exchange (m.room_key, m.room_key_request)
// - Device verification (m.key.verification.*)
// - Direct device-to-device communication
//
// Messages are delivered via /sync and sliding sync extensions

import { Hono } from "hono";
import type { AppEnv } from "../types";
import type { ToDeviceRequest } from "../types/client";
import { Errors } from "../utils/errors";
import { requireAuth } from "../middleware/auth";
import { dispatchToDeviceMessages } from "../matrix/application/features/to-device/command";
import { projectToDeviceMessages } from "../matrix/application/features/to-device/project";
import { queueFederationEdu } from "../matrix/application/features/shared/federation-edu-queue";
import type {
  DirectToDeviceEduContent,
  ToDeviceBatch,
} from "../matrix/application/features/to-device/contracts";

const app = new Hono<AppEnv>();

// ============================================
// Helper Functions
// ============================================

async function getNextStreamPosition(db: D1Database, streamName: string): Promise<number> {
  // Atomic UPDATE with RETURNING - no race condition
  const result = await db
    .prepare(`
    UPDATE stream_positions
    SET position = position + 1
    WHERE stream_name = ?
    RETURNING position
  `)
    .bind(streamName)
    .first<{ position: number }>();

  if (result) {
    return result.position;
  }

  // Row doesn't exist - atomic upsert (edge case, should be created by migration)
  const upsertResult = await db
    .prepare(`
    INSERT INTO stream_positions (stream_name, position)
    VALUES (?, 1)
    ON CONFLICT (stream_name) DO UPDATE SET position = position + 1
    RETURNING position
  `)
    .bind(streamName)
    .first<{ position: number }>();

  return upsertResult?.position ?? 1;
}

async function getUserDevices(db: D1Database, userId: string): Promise<string[]> {
  const devices = await db
    .prepare(`
    SELECT device_id FROM devices WHERE user_id = ?
  `)
    .bind(userId)
    .all<{ device_id: string }>();

  return devices.results.map((d) => d.device_id);
}

// ============================================
// Endpoints
// ============================================

// PUT /sendToDevice/:eventType/:txnId - Send to-device messages
app.put("/_matrix/client/v3/sendToDevice/:eventType/:txnId", requireAuth(), async (c) => {
  const userId = c.get("userId");
  const eventType = c.req.param("eventType");
  const txnId = c.req.param("txnId");
  const db = c.env.DB;

  // Check for duplicate transaction
  const existingTxn = await db
    .prepare(`
    SELECT response FROM transaction_ids WHERE user_id = ? AND txn_id = ?
  `)
    .bind(userId, txnId)
    .first<{ response: string }>();

  if (existingTxn) {
    // Return cached response for idempotency
    return c.json(JSON.parse(existingTxn.response || "{}"));
  }

  let body: ToDeviceRequest;
  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  if (!body.messages) {
    return Errors.missingParam("messages").toResponse();
  }

  await dispatchToDeviceMessages(
    {
      senderUserId: userId,
      eventType,
      txnId,
      messages: body.messages,
    },
    {
      localServerName: c.env.SERVER_NAME,
      getUserDevices: (recipientUserId: string) => getUserDevices(db, recipientUserId),
      nextStreamPosition: (streamName: string) => getNextStreamPosition(db, streamName),
      async storeLocalMessage(input) {
        await db
          .prepare(`
            INSERT INTO to_device_messages (
              recipient_user_id, recipient_device_id, sender_user_id,
              event_type, content, message_id, stream_position
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (recipient_user_id, recipient_device_id, message_id) DO NOTHING
          `)
          .bind(
            input.recipientUserId,
            input.recipientDeviceId,
            input.senderUserId,
            input.eventType,
            JSON.stringify(input.content),
            input.messageId,
            input.streamPosition,
          )
          .run();
      },
      async queueEdu(destination: string, content: DirectToDeviceEduContent) {
        await queueFederationEdu(c.env, destination, "m.direct_to_device", content);
      },
      debugEnabled: c.get("appContext").profile.name === "complement",
    },
  );

  // Store transaction for idempotency
  await db
    .prepare(`
    INSERT INTO transaction_ids (user_id, txn_id, response)
    VALUES (?, ?, '{}')
    ON CONFLICT (user_id, txn_id) DO NOTHING
  `)
    .bind(userId, txnId)
    .run();

  return c.json({});
});

// ============================================
// Internal helper: Get to-device messages for sync
// ============================================

export function getToDeviceMessages(
  db: D1Database,
  userId: string,
  deviceId: string,
  since?: string,
  limit: number = 100,
): Promise<ToDeviceBatch> {
  return projectToDeviceMessages(db, userId, deviceId, since, limit);
}

// ============================================
// Cleanup old messages (can be called periodically)
// ============================================

export async function cleanupOldToDeviceMessages(
  db: D1Database,
  maxAgeMs: number = 7 * 24 * 60 * 60 * 1000,
): Promise<number> {
  const cutoff = Date.now() - maxAgeMs;

  const result = await db
    .prepare(`
    DELETE FROM to_device_messages WHERE created_at < ? AND delivered = 1
  `)
    .bind(cutoff)
    .run();

  return result.meta.changes || 0;
}

export default app;
