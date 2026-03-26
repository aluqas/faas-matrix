export interface IdempotencyStore<TValue> {
  get(scope: string, key: string): Promise<TValue | null>;
  put(scope: string, key: string, value: TValue): Promise<void>;
}

export async function withIdempotency<TValue>(
  store: IdempotencyStore<TValue>,
  scope: string,
  key: string,
  producer: () => Promise<TValue>
): Promise<TValue> {
  const existing = await store.get(scope, key);
  if (existing !== null) {
    return existing;
  }

  const value = await producer();
  await store.put(scope, key, value);
  return value;
}

