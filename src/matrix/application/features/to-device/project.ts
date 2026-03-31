export async function projectToDeviceMessages(
  db: D1Database,
  userId: string,
  deviceId: string,
  since?: string,
  limit: number = 100,
): Promise<{
  events: Array<{ sender: string; type: string; content: Record<string, unknown> }>;
  nextBatch: string;
}> {
  let sincePos = 0;
  if (since) {
    const parsed = Number.parseInt(since, 10);
    if (!Number.isNaN(parsed) && parsed > 0 && parsed < 1_000_000_000) {
      sincePos = parsed;
    }
  }

  const messages = await db
    .prepare(`
      SELECT sender_user_id, event_type, content, stream_position
      FROM to_device_messages
      WHERE recipient_user_id = ?
        AND recipient_device_id = ?
        AND delivered = 0
        AND stream_position > ?
      ORDER BY stream_position ASC
      LIMIT ?
    `)
    .bind(userId, deviceId, sincePos, limit)
    .all<{
      sender_user_id: string;
      event_type: string;
      content: string;
      stream_position: number;
    }>();

  if (sincePos > 0) {
    await db
      .prepare(`
        UPDATE to_device_messages
        SET delivered = 1
        WHERE recipient_user_id = ?
          AND recipient_device_id = ?
          AND stream_position <= ?
          AND delivered = 0
      `)
      .bind(userId, deviceId, sincePos)
      .run();
  }

  const maxPos = await db
    .prepare(`SELECT COALESCE(MAX(stream_position), 0) as max_pos FROM to_device_messages`)
    .first<{ max_pos: number }>();

  const events = messages.results.map((message) => ({
    sender: message.sender_user_id,
    type: message.event_type,
    content: JSON.parse(message.content) as Record<string, unknown>,
  }));

  const nextBatch =
    messages.results.length > 0
      ? String(messages.results[messages.results.length - 1].stream_position)
      : String(maxPos?.max_pos || 0);

  return { events, nextBatch };
}
