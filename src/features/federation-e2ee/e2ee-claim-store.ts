import type {
  AppEnv,
  FederationClaimedOneTimeKeyRecord,
  UserId,
} from "../../shared/types";
import type {
  DeviceOneTimeKeysMap,
  StoredOneTimeKeyBuckets,
} from "../../shared/types/client";
import {
  claimFallbackKey,
  claimUnclaimedOneTimeKey,
  markStoredOneTimeKeyClaimed,
} from "../../infra/repositories/federation-e2ee-repository";
import {
  loadStoredOneTimeKeyBuckets,
  saveStoredOneTimeKeyBuckets,
} from "./e2ee-gateway";

export interface ClaimedOneTimeKeyResult extends FederationClaimedOneTimeKeyRecord {
  isFallback: boolean;
}

function markFallbackKey(
  keyData: FederationClaimedOneTimeKeyRecord["keyData"],
): FederationClaimedOneTimeKeyRecord["keyData"] {
  return {
    ...keyData,
    fallback: true,
  };
}

export function toClaimedOneTimeKeyEntry(
  claimedKey: ClaimedOneTimeKeyResult,
): DeviceOneTimeKeysMap[string] {
  return {
    [claimedKey.keyId]: claimedKey.isFallback ? markFallbackKey(claimedKey.keyData) : claimedKey.keyData,
  };
}

export async function claimStoredOneTimeKeyWithMirrorMark(
  env: Pick<AppEnv["Bindings"], "DB" | "ONE_TIME_KEYS">,
  userId: UserId,
  deviceId: string,
  algorithm: string,
  claimedAt: number,
): Promise<FederationClaimedOneTimeKeyRecord | null> {
  const existingKeys = await loadStoredOneTimeKeyBuckets(env, userId, deviceId);
  const bucket = existingKeys?.[algorithm];
  if (!bucket) {
    return null;
  }

  const keyIndex = bucket.findIndex((key) => !key.claimed);
  if (keyIndex < 0) {
    return null;
  }

  const key = bucket[keyIndex];
  if (!key) {
    return null;
  }

  const nextBuckets: StoredOneTimeKeyBuckets = {
    ...existingKeys,
    [algorithm]: bucket.map((entry, index) =>
      index === keyIndex ? { ...entry, claimed: true } : entry,
    ),
  };

  await saveStoredOneTimeKeyBuckets(env, userId, deviceId, nextBuckets);

  try {
    await markStoredOneTimeKeyClaimed(env.DB, userId, deviceId, key.keyId, claimedAt);
  } catch (error) {
    try {
      await saveStoredOneTimeKeyBuckets(env, userId, deviceId, existingKeys);
    } catch (rollbackError) {
      throw new Error("Failed to mirror stored one-time key claim and rollback KV state", {
        cause: rollbackError,
      });
    }

    throw error;
  }

  return {
    keyId: key.keyId,
    keyData: key.keyData,
  };
}

export async function claimOneTimeKeyFromStoreChain(
  env: Pick<AppEnv["Bindings"], "DB" | "ONE_TIME_KEYS">,
  userId: UserId,
  deviceId: string,
  algorithm: string,
  claimedAt: number,
): Promise<ClaimedOneTimeKeyResult | null> {
  const storedKey = await claimStoredOneTimeKeyWithMirrorMark(
    env,
    userId,
    deviceId,
    algorithm,
    claimedAt,
  );
  if (storedKey) {
    return {
      ...storedKey,
      isFallback: false,
    };
  }

  const dbKey = await claimUnclaimedOneTimeKey(env.DB, userId, deviceId, algorithm, claimedAt);
  if (dbKey) {
    return {
      ...dbKey,
      isFallback: false,
    };
  }

  const fallbackKey = await claimFallbackKey(env.DB, userId, deviceId, algorithm);
  if (!fallbackKey) {
    return null;
  }

  return {
    ...fallbackKey,
    isFallback: true,
  };
}
