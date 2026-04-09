import type { IdempotencyStore } from "../../shared/runtime/idempotency";
import { getTransaction, storeTransaction } from "../../infra/realtime/transactions";

export class CloudflareIdempotencyStore implements IdempotencyStore<Record<string, unknown>> {
  constructor(private readonly db: D1Database) {}

  async get(scope: string, key: string): Promise<Record<string, unknown> | null> {
    const existing = await getTransaction(this.db, scope, key);
    return existing?.response ?? (existing?.eventId ? { event_id: existing.eventId } : null);
  }

  async put(scope: string, key: string, value: Record<string, unknown>): Promise<void> {
    const eventId = typeof value.event_id === "string" ? value.event_id : undefined;
    await storeTransaction(this.db, scope, key, eventId, value);
  }
}
