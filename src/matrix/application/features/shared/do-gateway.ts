type DurableObjectEnv<TBinding extends string> = Record<TBinding, DurableObjectNamespace>;

function getDurableObjectStub<TBinding extends string>(
  env: DurableObjectEnv<TBinding>,
  binding: TBinding,
  name: string,
): DurableObjectStub {
  const id = env[binding].idFromName(name);
  return env[binding].get(id);
}

async function parseJsonResponse(response: Response, operation: string): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    throw new Error(`${operation} returned invalid JSON`, { cause: error });
  }
}

async function assertOk(response: Response, operation: string): Promise<void> {
  if (response.ok) {
    return;
  }

  const errorText = await response.text().catch(() => "unknown error");
  throw new Error(`${operation} failed: ${response.status} - ${errorText}`);
}

async function fetchDurableObjectResponse<TBinding extends string>(
  env: DurableObjectEnv<TBinding>,
  binding: TBinding,
  name: string,
  request: Request,
  operation: string,
): Promise<Response> {
  try {
    return await getDurableObjectStub(env, binding, name).fetch(request);
  } catch (error) {
    throw new Error(`${operation} transport failed`, { cause: error });
  }
}

export async function fetchDurableObjectJson<TBinding extends string>(
  env: DurableObjectEnv<TBinding>,
  binding: TBinding,
  name: string,
  url: string,
  operation: string,
): Promise<unknown> {
  const response = await fetchDurableObjectResponse(
    env,
    binding,
    name,
    new Request(url),
    operation,
  );
  await assertOk(response, operation);
  return parseJsonResponse(response, operation);
}

export async function postDurableObjectJson<TBinding extends string>(
  env: DurableObjectEnv<TBinding>,
  binding: TBinding,
  name: string,
  url: string,
  body: unknown,
  operation: string,
): Promise<unknown> {
  const response = await fetchDurableObjectResponse(
    env,
    binding,
    name,
    new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    operation,
  );
  await assertOk(response, operation);
  return parseJsonResponse(response, operation);
}

export async function postDurableObjectVoid<TBinding extends string>(
  env: DurableObjectEnv<TBinding>,
  binding: TBinding,
  name: string,
  url: string,
  body: unknown,
  operation: string,
): Promise<void> {
  const response = await fetchDurableObjectResponse(
    env,
    binding,
    name,
    new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    operation,
  );
  await assertOk(response, operation);
}
