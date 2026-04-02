export async function getNextStreamPosition(db: D1Database, streamName: string): Promise<number> {
  await db
    .prepare(
      `
      UPDATE stream_positions SET position = position + 1 WHERE stream_name = ?
    `,
    )
    .bind(streamName)
    .run();

  const result = await db
    .prepare(
      `
      SELECT position FROM stream_positions WHERE stream_name = ?
    `,
    )
    .bind(streamName)
    .first<{ position: number }>();

  return result?.position || 1;
}

export async function recordDeviceKeyChange(
  db: D1Database,
  userId: string,
  deviceId: string | null,
  changeType: string,
): Promise<void> {
  const streamPosition = await getNextStreamPosition(db, "device_keys");

  await db
    .prepare(
      `
      INSERT INTO device_key_changes (user_id, device_id, change_type, stream_position)
      VALUES (?, ?, ?, ?)
    `,
    )
    .bind(userId, deviceId, changeType, streamPosition)
    .run();
}
