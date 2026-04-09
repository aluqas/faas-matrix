type KvEnv<TBinding extends string> = Record<TBinding, KVNamespace>;

export function getKvTextValue<TBinding extends string>(
  env: KvEnv<TBinding>,
  binding: TBinding,
  key: string,
): Promise<string | null> {
  return env[binding].get(key);
}

export function getKvJsonValue<TBinding extends string>(
  env: KvEnv<TBinding>,
  binding: TBinding,
  key: string,
): Promise<unknown> {
  return env[binding].get(key, "json");
}

export function putKvTextValue<TBinding extends string>(
  env: KvEnv<TBinding>,
  binding: TBinding,
  key: string,
  value: string,
  options?: KVNamespacePutOptions,
): Promise<void> {
  return env[binding].put(key, value, options);
}

export function putKvJsonValue<TBinding extends string>(
  env: KvEnv<TBinding>,
  binding: TBinding,
  key: string,
  value: unknown,
  options?: KVNamespacePutOptions,
): Promise<void> {
  return env[binding].put(key, JSON.stringify(value), options);
}

export function deleteKvValue<TBinding extends string>(
  env: KvEnv<TBinding>,
  binding: TBinding,
  key: string,
): Promise<void> {
  return env[binding].delete(key);
}
