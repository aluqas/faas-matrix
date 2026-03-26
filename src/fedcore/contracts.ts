export interface DiscoveryService<TTarget = unknown> {
  discover(serverName: string): Promise<TTarget>;
}

export interface SignedTransport {
  verifyJson(
    payload: Record<string, unknown>,
    origin: string,
    keyId: string
  ): Promise<boolean>;
}

export interface RemoteKeyCache<TKey = unknown> {
  get(serverName: string, keyId: string): Promise<TKey | null>;
  put(serverName: string, keyId: string, key: TKey): Promise<void>;
}

export interface DeliveryQueue<TMessage = unknown> {
  enqueue(destination: string, message: TMessage): Promise<void>;
}

