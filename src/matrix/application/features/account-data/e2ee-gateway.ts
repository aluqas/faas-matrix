import type { AccountDataContent, E2EEAccountDataMap } from "../../../../types/account-data";
import { normalizeE2EEAccountDataMap } from "../../../../types/account-data";
import type { Env } from "../../../../types";

function getUserKeysDO(env: Pick<Env, "USER_KEYS">, userId: string): DurableObjectStub {
  const id = env.USER_KEYS.idFromName(userId);
  return env.USER_KEYS.get(id);
}

export async function getE2EEAccountDataFromDO(
  env: Pick<Env, "USER_KEYS">,
  userId: string,
): Promise<E2EEAccountDataMap>;
export async function getE2EEAccountDataFromDO(
  env: Pick<Env, "USER_KEYS">,
  userId: string,
  eventType: string,
): Promise<AccountDataContent | null>;
export async function getE2EEAccountDataFromDO(
  env: Pick<Env, "USER_KEYS">,
  userId: string,
  eventType?: string,
): Promise<E2EEAccountDataMap | AccountDataContent | null> {
  const stub = getUserKeysDO(env, userId);
  const url = eventType
    ? `http://internal/account-data/get?event_type=${encodeURIComponent(eventType)}`
    : "http://internal/account-data/get";
  const response = await stub.fetch(new Request(url));

  if (!response.ok) {
    const errorText = await response.text().catch(() => "unknown error");
    throw new Error(`DO get failed: ${response.status} - ${errorText}`);
  }

  const payload = await response.json();
  if (eventType !== undefined) {
    return normalizeE2EEAccountDataMap({ [eventType]: payload })[eventType] ?? null;
  }
  return normalizeE2EEAccountDataMap(payload);
}

export async function putE2EEAccountDataToDO(
  env: Pick<Env, "USER_KEYS">,
  userId: string,
  eventType: string,
  content: AccountDataContent,
): Promise<void> {
  const stub = getUserKeysDO(env, userId);
  const response = await stub.fetch(
    new Request("http://internal/account-data/put", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event_type: eventType, content }),
    }),
  );

  if (!response.ok) {
    const errorText = await response.text().catch(() => "unknown error");
    throw new Error(`DO put failed: ${response.status} - ${errorText}`);
  }
}

export async function deleteE2EEAccountDataFromDO(
  env: Pick<Env, "USER_KEYS">,
  userId: string,
  eventType: string,
): Promise<void> {
  const stub = getUserKeysDO(env, userId);
  const response = await stub.fetch(
    new Request("http://internal/account-data/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event_type: eventType }),
    }),
  );

  if (!response.ok) {
    const errorText = await response.text().catch(() => "unknown error");
    throw new Error(`DO delete failed: ${response.status} - ${errorText}`);
  }
}
