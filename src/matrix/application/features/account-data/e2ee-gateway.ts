import type { AccountDataContent, E2EEAccountDataMap } from "../../../../types/account-data";
import { normalizeE2EEAccountDataMap } from "../../../../types/account-data";
import type { Env } from "../../../../types";
import {
  fetchDurableObjectJson,
  postDurableObjectVoid,
} from "../shared/do-gateway";

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
  const url = eventType
    ? `http://internal/account-data/get?event_type=${encodeURIComponent(eventType)}`
    : "http://internal/account-data/get";
  const payload = await fetchDurableObjectJson(env, "USER_KEYS", userId, url, "DO account-data get");
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
  await postDurableObjectVoid(
    env,
    "USER_KEYS",
    userId,
    "http://internal/account-data/put",
    { event_type: eventType, content },
    "DO account-data put",
  );
}

export async function deleteE2EEAccountDataFromDO(
  env: Pick<Env, "USER_KEYS">,
  userId: string,
  eventType: string,
): Promise<void> {
  await postDurableObjectVoid(
    env,
    "USER_KEYS",
    userId,
    "http://internal/account-data/delete",
    { event_type: eventType },
    "DO account-data delete",
  );
}
