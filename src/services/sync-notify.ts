export async function notifySyncUser(
  env: { SYNC: DurableObjectNamespace },
  userId: string,
  payload?: {
    eventId?: string;
    roomId?: string;
    type?: string;
    timestamp?: number;
  },
): Promise<void> {
  const syncDO = env.SYNC.get(env.SYNC.idFromName(userId));
  await syncDO.fetch(
    new Request("http://internal/notify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event_id: payload?.eventId ?? `$account_data:${userId}:${Date.now()}`,
        room_id: payload?.roomId ?? "",
        type: payload?.type ?? "m.account_data",
        timestamp: payload?.timestamp ?? Date.now(),
      }),
    }),
  );
}
