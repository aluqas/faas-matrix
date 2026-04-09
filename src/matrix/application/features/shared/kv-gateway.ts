type KvEnv<TBinding extends string> = Record<TBinding, KVNamespace>;

export function getKvTextValue<TBinding extends string>(
  env: KvEnv<TBinding>,
  binding: TBinding,
  key: string,
): Promise<string | null> {
  return env[binding]
    .get(key)
    .catch((error) => {
      throw new Error(`${binding} KV get failed for ${key}`, { cause: error });
    });
}

export function getKvJsonValue<TBinding extends string>(
  env: KvEnv<TBinding>,
  binding: TBinding,
  key: string,
): Promise<unknown> {
  return env[binding]
    .get(key, "json")
    .catch((error) => {
      throw new Error(`${binding} KV get failed for ${key}`, { cause: error });
    });
}

export function putKvTextValue<TBinding extends string>(
  env: KvEnv<TBinding>,
  binding: TBinding,
  key: string,
  value: string,
  options?: KVNamespacePutOptions,
): Promise<void> {
  return env[binding]
    .put(key, value, options)
    .catch((error) => {
      throw new Error(`${binding} KV put failed for ${key}`, { cause: error });
    });
}

export function putKvJsonValue<TBinding extends string>(
  env: KvEnv<TBinding>,
  binding: TBinding,
  key: string,
  value: unknown,
  options?: KVNamespacePutOptions,
): Promise<void> {
  return env[binding]
    .put(key, JSON.stringify(value), options)
    .catch((error) => {
      throw new Error(`${binding} KV put failed for ${key}`, { cause: error });
    });
}

export function deleteKvValue<TBinding extends string>(
  env: KvEnv<TBinding>,
  binding: TBinding,
  key: string,
): Promise<void> {
  return env[binding]
    .delete(key)
    .catch((error) => {
      throw new Error(`${binding} KV delete failed for ${key}`, { cause: error });
    });
}
