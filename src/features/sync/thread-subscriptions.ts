function parseThreadSubscriptionRecord(
  value: unknown,
): { automatic: boolean; subscribed: boolean } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const automaticValue = (value as Record<string, unknown>)["automatic"];
  const subscribedValue = (value as Record<string, unknown>)["subscribed"];
  return {
    automatic: automaticValue === true,
    subscribed: subscribedValue !== false,
  };
}

function parseThreadSubscriptionsContent(
  rawContent: string,
): Record<string, { automatic: boolean; subscribed: boolean }> {
  try {
    const parsed = JSON.parse(rawContent) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    const subscriptions: Record<string, { automatic: boolean; subscribed: boolean }> = {};
    for (const [threadRootId, value] of Object.entries(parsed as Record<string, unknown>)) {
      const record = parseThreadSubscriptionRecord(value);
      if (record) {
        subscriptions[threadRootId] = record;
      }
    }
    return subscriptions;
  } catch {
    return {};
  }
}

export async function getThreadSubscriptionsExtension(
  db: D1Database,
  userId: string,
  eventType: string,
  roomIds?: string[],
): Promise<Record<string, Record<string, { bump_stamp: number; automatic: boolean }>> | undefined> {
  let query = `
    SELECT room_id, content
    FROM account_data
    WHERE user_id = ? AND event_type = ? AND room_id != '' AND deleted = 0
  `;
  const params: (string | number)[] = [userId, eventType];

  if (roomIds && roomIds.length > 0) {
    query += ` AND room_id IN (${roomIds.map(() => "?").join(", ")})`;
    params.push(...roomIds);
  }

  const subscriptionRows = await db
    .prepare(query)
    .bind(...params)
    .all<{ room_id: string; content: string }>();

  const subscribed: Record<string, Record<string, { bump_stamp: number; automatic: boolean }>> = {};

  for (const row of subscriptionRows.results) {
    const roomSubscriptions = parseThreadSubscriptionsContent(row.content);
    const activeThreadRootIds = Object.keys(roomSubscriptions).filter(
      (threadRootId) => roomSubscriptions[threadRootId]?.subscribed,
    );
    if (activeThreadRootIds.length === 0) {
      continue;
    }

    const bumpStampRows = await db
      .prepare(
        `
        SELECT event_id, origin_server_ts
        FROM events
        WHERE room_id = ? AND event_id IN (${activeThreadRootIds.map(() => "?").join(", ")})
      `,
      )
      .bind(row.room_id, ...activeThreadRootIds)
      .all<{ event_id: string; origin_server_ts: number }>();

    const bumpStampByEventId = new Map(
      bumpStampRows.results.map((event) => [event.event_id, event.origin_server_ts] as const),
    );

    subscribed[row.room_id] = {};
    for (const [threadRootId, subscription] of Object.entries(roomSubscriptions)) {
      if (!subscription.subscribed) {
        continue;
      }
      subscribed[row.room_id][threadRootId] = {
        bump_stamp: bumpStampByEventId.get(threadRootId) ?? Date.now(),
        automatic: subscription.automatic,
      };
    }
  }

  return Object.keys(subscribed).length > 0 ? subscribed : undefined;
}
