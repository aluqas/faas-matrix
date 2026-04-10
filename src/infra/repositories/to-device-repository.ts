import { sql, type RawBuilder } from "kysely";
import {
  createKyselyBuilder,
  executeKyselyQuery,
  executeKyselyQueryFirst,
  executeKyselyRun,
  type CompiledQuery,
} from "../../infra/db/kysely";
import type { DeviceId, UserId } from "../../shared/types";
import type { ToDeviceBatch } from "../../features/to-device/contracts";

interface StreamPositionRow {
  stream_name: string;
  position: number;
}

interface DeviceRow {
  user_id: string;
  device_id: string;
  display_name: string | null;
  last_seen_ts: number | null;
  last_seen_ip: string | null;
}

interface ToDeviceMessageRow {
  recipient_user_id: string;
  recipient_device_id: string;
  sender_user_id: string;
  event_type: string;
  content: string;
  message_id: string;
  stream_position: number;
  delivered: number;
  created_at: number;
}

interface TransactionRow {
  user_id: string;
  txn_id: string;
  response: string;
}

interface DeviceKeyChangeRow {
  user_id: string;
  device_id: string | null;
  change_type: string;
  stream_position: number;
}

interface ToDeviceDatabase {
  stream_positions: StreamPositionRow;
  devices: DeviceRow;
  to_device_messages: ToDeviceMessageRow;
  transaction_ids: TransactionRow;
  device_key_changes: DeviceKeyChangeRow;
}

const qb = createKyselyBuilder<ToDeviceDatabase>();

function asCompiledQuery<T>(query: RawBuilder<T>): CompiledQuery {
  return {
    compile: () => query.compile(qb),
  };
}

function parseSincePosition(since?: string): number {
  if (!since) {
    return 0;
  }

  const parsed = Number.parseInt(since, 10);
  return !Number.isNaN(parsed) && parsed > 0 && parsed < 1_000_000_000 ? parsed : 0;
}

function parseMessageContent(content: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(content) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export async function getNextNamedStreamPosition(
  db: D1Database,
  streamName: string,
): Promise<number> {
  const result = await executeKyselyQueryFirst<{ position: number }>(
    db,
    asCompiledQuery(sql<{ position: number }>`
      UPDATE stream_positions
      SET position = position + 1
      WHERE stream_name = ${streamName}
      RETURNING position
    `),
  );

  if (result) {
    return result.position;
  }

  const upsertResult = await executeKyselyQueryFirst<{ position: number }>(
    db,
    asCompiledQuery(sql<{ position: number }>`
      INSERT INTO stream_positions (stream_name, position)
      VALUES (${streamName}, 1)
      ON CONFLICT (stream_name) DO UPDATE SET position = position + 1
      RETURNING position
    `),
  );

  return upsertResult?.position ?? 1;
}

export async function listUserDeviceIds(db: D1Database, userId: UserId): Promise<string[]> {
  const rows = await executeKyselyQuery<Pick<DeviceRow, "device_id">>(
    db,
    asCompiledQuery(
      sql<Pick<DeviceRow, "device_id">>`SELECT device_id FROM devices WHERE user_id = ${userId}`,
    ),
  );
  return rows.map((row) => row.device_id);
}

export async function insertToDeviceMessage(
  db: D1Database,
  input: {
    recipientUserId: string;
    recipientDeviceId: string;
    senderUserId: string;
    eventType: string;
    content: Record<string, unknown>;
    messageId: string;
    streamPosition: number;
  },
): Promise<void> {
  await executeKyselyRun(
    db,
    asCompiledQuery(sql`
      INSERT INTO to_device_messages (
        recipient_user_id,
        recipient_device_id,
        sender_user_id,
        event_type,
        content,
        message_id,
        stream_position,
        delivered,
        created_at
      )
      VALUES (
        ${input.recipientUserId},
        ${input.recipientDeviceId},
        ${input.senderUserId},
        ${input.eventType},
        ${JSON.stringify(input.content)},
        ${input.messageId},
        ${input.streamPosition},
        0,
        ${Date.now()}
      )
      ON CONFLICT (recipient_user_id, recipient_device_id, message_id) DO NOTHING
    `),
  );
}

export async function findStoredTransactionResponse(
  db: D1Database,
  userId: UserId,
  txnId: string,
): Promise<Record<string, unknown> | null> {
  const row = await executeKyselyQueryFirst<Pick<TransactionRow, "response">>(
    db,
    qb
      .selectFrom("transaction_ids")
      .select("response")
      .where("user_id", "=", userId)
      .where("txn_id", "=", txnId)
      .limit(1),
  );

  if (!row) {
    return null;
  }

  try {
    const parsed = JSON.parse(row.response) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export async function storeTransactionResponse(
  db: D1Database,
  userId: UserId,
  txnId: string,
  response: Record<string, unknown>,
): Promise<void> {
  await executeKyselyRun(
    db,
    qb
      .insertInto("transaction_ids")
      .values({
        user_id: userId,
        txn_id: txnId,
        response: JSON.stringify(response),
      })
      .onConflict((oc) => oc.columns(["user_id", "txn_id"]).doNothing()),
  );
}

export async function loadToDeviceMessagesBatch(
  db: D1Database,
  userId: UserId,
  deviceId: DeviceId,
  since?: string,
  limit: number = 100,
): Promise<ToDeviceBatch> {
  const sincePos = parseSincePosition(since);

  const messages = await executeKyselyQuery<
    Pick<ToDeviceMessageRow, "sender_user_id" | "event_type" | "content" | "stream_position">
  >(
    db,
    qb
      .selectFrom("to_device_messages")
      .select(["sender_user_id", "event_type", "content", "stream_position"])
      .where("recipient_user_id", "=", userId)
      .where("recipient_device_id", "=", deviceId)
      .where("delivered", "=", 0)
      .where("stream_position", ">", sincePos)
      .orderBy("stream_position", "asc")
      .limit(limit),
  );

  if (sincePos > 0) {
    await executeKyselyRun(
      db,
      qb
        .updateTable("to_device_messages")
        .set({ delivered: 1 })
        .where("recipient_user_id", "=", userId)
        .where("recipient_device_id", "=", deviceId)
        .where("stream_position", "<=", sincePos)
        .where("delivered", "=", 0),
    );
  }

  const maxPos = await executeKyselyQueryFirst<{ max_pos: number | null }>(
    db,
    qb.selectFrom("to_device_messages").select((eb) => eb.fn.max("stream_position").as("max_pos")),
  );

  return {
    events: messages.map((message) => ({
      sender: message.sender_user_id,
      type: message.event_type,
      content: parseMessageContent(message.content),
    })),
    nextBatch:
      messages.length > 0
        ? String(messages.at(-1)?.stream_position ?? sincePos)
        : String(maxPos?.max_pos ?? 0),
  };
}

export async function deleteDeliveredToDeviceMessagesBefore(
  db: D1Database,
  cutoff: number,
): Promise<number> {
  const result = await executeKyselyQueryFirst<{ count: number }>(
    db,
    asCompiledQuery(sql<{ count: number }>`
      WITH deleted AS (
        DELETE FROM to_device_messages
        WHERE created_at < ${cutoff} AND delivered = 1
        RETURNING 1
      )
      SELECT COUNT(*) AS count FROM deleted
    `),
  );

  return result?.count ?? 0;
}

export async function recordDeviceKeyChangeEntry(
  db: D1Database,
  userId: UserId,
  deviceId: string | null,
  changeType: string,
): Promise<void> {
  const streamPosition = await getNextNamedStreamPosition(db, "device_keys");

  await executeKyselyRun(
    db,
    qb.insertInto("device_key_changes").values({
      user_id: userId,
      device_id: deviceId,
      change_type: changeType,
      stream_position: streamPosition,
    }),
  );
}
