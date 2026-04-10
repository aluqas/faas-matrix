import type { AppEnv } from "../../shared/types";
import type {
  JsonObjectMap,
  KeysClaimRequest,
  UserOneTimeKeysMap,
} from "../../shared/types/client";
import { runClientEffect } from "../../matrix/application/runtime/effect-runtime";
import { createKeysLogger } from "./shared";
import {
  claimOneTimeKeyFromStoreChain,
  toClaimedOneTimeKeyEntry,
} from "../e2ee-shared/claim-store";
import { toUserId } from "../../shared/utils/ids";

export async function claimClientKeys(input: {
  env: Pick<
    AppEnv["Bindings"],
    | "DB"
    | "CACHE"
    | "ONE_TIME_KEYS"
    | "USER_KEYS"
    | "CROSS_SIGNING_KEYS"
    | "DEVICE_KEYS"
    | "SERVER_NAME"
  >;
  userId: string | null;
  request: KeysClaimRequest;
}): Promise<{ oneTimeKeys: UserOneTimeKeysMap; failures: JsonObjectMap }> {
  const logger = createKeysLogger("claim", { user_id: input.userId });
  const requestedKeys = input.request.one_time_keys;

  await runClientEffect(
    logger.info("keys.command.start", {
      command: "claim",
      requested_user_count: requestedKeys ? Object.keys(requestedKeys).length : 0,
    }),
  );

  const oneTimeKeys: UserOneTimeKeysMap = {};
  const failures: JsonObjectMap = {};

  if (requestedKeys) {
    for (const [userId, devices] of Object.entries(requestedKeys)) {
      const typedUserId = toUserId(userId);
      if (!typedUserId) {
        continue;
      }
      oneTimeKeys[typedUserId] = {};

      for (const [deviceId, algorithm] of Object.entries(devices)) {
        const claimedKey = await claimOneTimeKeyFromStoreChain(
          input.env,
          typedUserId,
          deviceId,
          algorithm,
          Date.now(),
        );

        if (claimedKey) {
          oneTimeKeys[typedUserId][deviceId] = toClaimedOneTimeKeyEntry(claimedKey);
        }
      }
    }
  }

  await runClientEffect(
    logger.info("keys.command.success", {
      command: "claim",
      returned_user_count: Object.keys(oneTimeKeys).length,
    }),
  );

  return { oneTimeKeys, failures };
}
