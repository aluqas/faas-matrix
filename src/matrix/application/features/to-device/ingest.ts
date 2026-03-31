async function getNextStreamPosition(db: D1Database, streamName: string): Promise<number> {
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

async function getLocalDeviceIds(db: D1Database, userId: string): Promise<string[]> {
  const devices = await db
    .prepare(`SELECT device_id FROM devices WHERE user_id = ?`)
    .bind(userId)
    .all<{ device_id: string }>();

  return devices.results.map((device) => device.device_id);
}

export async function ingestDirectToDeviceEdu(
  db: D1Database,
  origin: string,
  content: Record<string, unknown>,
): Promise<void> {
  const sender = typeof content.sender === "string" ? content.sender : origin;
  const eventType = typeof content.type === "string" ? content.type : undefined;
  const messageId = typeof content.message_id === "string" ? content.message_id : undefined;
  const messages =
    content.messages && typeof content.messages === "object"
      ? (content.messages as Record<string, Record<string, unknown>>)
      : undefined;

  if (!eventType || !messageId || !messages) {
    return;
  }

  for (const [recipientUserId, deviceMessages] of Object.entries(messages)) {
    if (!deviceMessages || typeof deviceMessages !== "object") {
      continue;
    }

    for (const [deviceId, messageContent] of Object.entries(deviceMessages)) {
      const targetDevices =
        deviceId === "*" ? await getLocalDeviceIds(db, recipientUserId) : [deviceId];

      for (const targetDeviceId of targetDevices) {
        const streamPosition = await getNextStreamPosition(db, "to_device");
        await db
          .prepare(
            `INSERT INTO to_device_messages (
              recipient_user_id, recipient_device_id, sender_user_id,
              event_type, content, message_id, stream_position
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (recipient_user_id, recipient_device_id, message_id) DO NOTHING`,
          )
          .bind(
            recipientUserId,
            targetDeviceId,
            sender,
            eventType,
            JSON.stringify(
              messageContent && typeof messageContent === "object" ? messageContent : {},
            ),
            messageId,
            streamPosition,
          )
          .run();
      }
    }
  }
}
