import type { Env } from "../../../../platform/cloudflare/env";
import { Errors, MatrixApiError } from "../../../../fatrix-model/utils/errors";
import { verifyPassword } from "../../../../fatrix-model/utils/crypto";
import { generateOpaqueId, toUserId } from "../../../../fatrix-model/utils/ids";
import { runClientEffect } from "../../runtime/effect-runtime";
import { loadGlobalAccountDataEffect } from "../../../../platform/cloudflare/adapters/application-ports/account-data/storage";
import {
  cacheCrossSigningKeys,
  cacheDeviceKeys,
  fetchCrossSigningKeysFromDO,
  fetchDeviceKeyFromDO,
  storeCrossSigningKeysToDO,
  storeDeviceKeysToDO,
} from "../../../../platform/cloudflare/adapters/application-ports/federation-e2ee/e2ee-gateway";
import {
  hasCrossSigningKeysBackup,
  recordDeviceKeyChangeWithKysely,
  storeCrossSigningKeysBackup,
  upsertCrossSigningSignature,
} from "../../../../platform/cloudflare/adapters/repositories/e2ee-repository";
import { getUserPasswordHash } from "../../../../platform/cloudflare/adapters/repositories/user-auth-repository";
import {
  assertCompletedUiaAuth,
  buildCrossSigningUiaChallenge,
  deleteUiaSession,
  hasPassword,
  initializeCrossSigningUiaSession,
  isOidcUser,
  loadUiaSession,
} from "./uia";
import { createKeysLogger } from "./shared";
import type { CrossSigningUploadRequest, SignaturesUploadRequest } from "../../../../fatrix-model/types/client";
import { isIdempotentCrossSigningUpload } from "../../../../fatrix-model/types/keys-contracts";

export interface CrossSigningUploadOutcome {
  status: 200 | 401;
  body: Record<string, unknown>;
}

async function loadAuthContext(input: {
  env: Pick<Env, "DB" | "CACHE">;
  userId: string;
  request: CrossSigningUploadRequest;
}) {
  const { env, userId, request } = input;
  const hasExistingKeys = await hasCrossSigningKeysBackup(env.DB, userId);
  const existingCSKeys = hasExistingKeys
    ? await fetchCrossSigningKeysFromDO(env as Env, userId)
    : {};
  const uploadRequest = {
    ...(request.master_key ? { master_key: request.master_key } : {}),
    ...(request.self_signing_key ? { self_signing_key: request.self_signing_key } : {}),
    ...(request.user_signing_key ? { user_signing_key: request.user_signing_key } : {}),
    ...(request.auth ? { auth: request.auth } : {}),
  };
  const idempotent =
    hasExistingKeys && isIdempotentCrossSigningUpload(existingCSKeys, uploadRequest);
  const userIsOIDC = await isOidcUser(env.DB, userId);
  const userHasPassword = await hasPassword(env.DB, userId);

  return {
    hasExistingKeys,
    existingCSKeys,
    idempotent,
    userIsOIDC,
    userHasPassword,
  };
}

async function validateCrossSigningAuth(input: {
  env: Pick<Env, "DB" | "CACHE">;
  userId: string;
  auth: NonNullable<CrossSigningUploadRequest["auth"]>;
}): Promise<void> {
  const { env, userId, auth } = input;

  if (auth.type === "m.login.password") {
    const typedUserId = toUserId(userId);
    if (!typedUserId) {
      throw Errors.unauthorized();
    }
    const storedHash = await getUserPasswordHash(env.DB, typedUserId);
    if (!storedHash) {
      throw Errors.forbidden("No password set for user");
    }
    if (!auth.password) {
      throw Errors.missingParam("auth.password");
    }
    const valid = await verifyPassword(auth.password, storedHash);
    if (!valid) {
      throw Errors.forbidden("Invalid password");
    }
    return;
  }

  if (
    auth.type === "org.matrix.cross_signing_reset" ||
    auth.type === "m.oauth" ||
    auth.type === "m.login.oauth" ||
    auth.type === "m.login.sso" ||
    auth.type === "m.login.token" ||
    !auth.type
  ) {
    const session = auth.session ? await loadUiaSession(env.CACHE, auth.session) : null;
    assertCompletedUiaAuth(userId, session, auth);
    if (auth.session) {
      await deleteUiaSession(env.CACHE, auth.session);
    }
    return;
  }

  throw new MatrixApiError("M_UNRECOGNIZED", `Unrecognized auth type: ${auth.type}`, 400);
}

export async function uploadCrossSigningKeys(input: {
  env: Pick<
    Env,
    | "DB"
    | "CACHE"
    | "SERVER_NAME"
    | "USER_KEYS"
    | "DEVICE_KEYS"
    | "CROSS_SIGNING_KEYS"
    | "ACCOUNT_DATA"
    | "ONE_TIME_KEYS"
  >;
  userId: string;
  request: CrossSigningUploadRequest;
}): Promise<CrossSigningUploadOutcome> {
  const { env, userId, request } = input;
  const { master_key, self_signing_key, user_signing_key, auth } = request;
  const logger = createKeysLogger("device_signing_upload", { user_id: userId });

  await runClientEffect(
    logger.info("keys.command.start", {
      command: "device_signing_upload",
      has_master_key: Boolean(master_key),
      has_self_signing_key: Boolean(self_signing_key),
      has_user_signing_key: Boolean(user_signing_key),
      auth_type: auth?.type,
    }),
  );

  const authContext = await loadAuthContext({ env, userId, request });

  await runClientEffect(
    logger.info("keys.command.auth_context", {
      has_existing_keys: authContext.hasExistingKeys,
      is_idempotent_upload: authContext.idempotent,
      is_oidc_user: authContext.userIsOIDC,
      has_password: authContext.userHasPassword,
    }),
  );

  if (!authContext.hasExistingKeys || authContext.idempotent) {
    await runClientEffect(
      logger.info("keys.command.uia_skipped", {
        reason: authContext.hasExistingKeys ? "idempotent_reupload" : "first_time_setup",
      }),
    );
  } else if (!auth) {
    const sessionId = await generateOpaqueId(16);
    await initializeCrossSigningUiaSession({
      cache: env.CACHE,
      sessionId,
      userId,
      isOidcUser: authContext.userIsOIDC,
      hasPassword: authContext.userHasPassword,
    });
    await runClientEffect(
      logger.info("keys.command.uia_required", {
        session_id: sessionId,
      }),
    );
    return {
      status: 401,
      body: buildCrossSigningUiaChallenge({
        serverName: env.SERVER_NAME,
        sessionId,
        isOidcUser: authContext.userIsOIDC,
        hasPassword: authContext.userHasPassword,
      }),
    };
  } else {
    await validateCrossSigningAuth({ env, userId, auth });
    await runClientEffect(
      logger.info("keys.command.auth_success", {
        auth_type: auth.type ?? "session_only",
      }),
    );
  }

  const typedUserId = toUserId(userId);
  if (!typedUserId) {
    throw Errors.unauthorized();
  }

  const ssssDefault = await runClientEffect(
    loadGlobalAccountDataEffect(
      env as Env,
      typedUserId,
      "m.secret_storage.default_key",
    ),
  );
  await runClientEffect(
    logger.info("keys.command.ssss_state", {
      has_valid_ssss: !!ssssDefault?.["key"],
    }),
  );

  const csKeys = { ...authContext.existingCSKeys };
  if (master_key) csKeys.master = master_key;
  if (self_signing_key) csKeys.self_signing = self_signing_key;
  if (user_signing_key) csKeys.user_signing = user_signing_key;

  await storeCrossSigningKeysToDO(env as Env, userId, csKeys);
  await storeCrossSigningKeysBackup(env.DB, userId, csKeys, Boolean(master_key));
  await cacheCrossSigningKeys(env as Env, userId, csKeys);

  await runClientEffect(
    logger.info("keys.command.success", {
      command: "device_signing_upload",
      has_master_key: Boolean(master_key),
      has_self_signing_key: Boolean(self_signing_key),
      has_user_signing_key: Boolean(user_signing_key),
    }),
  );

  return { status: 200, body: {} };
}

export async function uploadKeySignatures(input: {
  env: Pick<
    Env,
    | "DB"
    | "CACHE"
    | "USER_KEYS"
    | "DEVICE_KEYS"
    | "CROSS_SIGNING_KEYS"
    | "ONE_TIME_KEYS"
    | "SERVER_NAME"
  >;
  signerUserId: string;
  request: SignaturesUploadRequest;
}): Promise<{
  failures: Record<string, Record<string, { errcode: string; error: string }>>;
}> {
  const { env, signerUserId, request } = input;
  const logger = createKeysLogger("signatures_upload", { user_id: signerUserId });

  await runClientEffect(
    logger.info("keys.command.start", {
      command: "signatures_upload",
      target_user_count: Object.keys(request).length,
    }),
  );

  const failures: Record<string, Record<string, { errcode: string; error: string }>> = {};

  for (const [userId, keys] of Object.entries(request)) {
    for (const [keyId, signedKeyObj] of Object.entries(keys)) {
      try {
        const signatures = signedKeyObj.signatures?.[signerUserId] ?? {};
        await runClientEffect(
          logger.info("keys.command.signature_process", {
            target_user_id: userId,
            key_id: keyId,
            has_device_id: Boolean(signedKeyObj.device_id),
            signature_count: Object.keys(signatures).length,
          }),
        );

        for (const [signerKeyId, signature] of Object.entries(signatures)) {
          const effectiveKeyId = signedKeyObj.device_id ?? keyId;
          await upsertCrossSigningSignature(
            env.DB,
            userId,
            effectiveKeyId,
            signerUserId,
            signerKeyId,
            signature,
          );
        }

        if (signedKeyObj.device_id) {
          const deviceId = signedKeyObj.device_id;
          const existingKey = await fetchDeviceKeyFromDO(
            env as Env,
            userId,
            deviceId,
          );
          if (existingKey) {
            existingKey.signatures = existingKey.signatures ?? {};
            existingKey.signatures[signerUserId] = {
              ...existingKey.signatures[signerUserId],
              ...signatures,
            };
            await storeDeviceKeysToDO(env as Env, userId, deviceId, existingKey);
            await cacheDeviceKeys(env as Env, userId, deviceId, existingKey);
          } else {
            await runClientEffect(
              logger.warn("keys.command.signature_missing_device", {
                target_user_id: userId,
                device_id: deviceId,
              }),
            );
          }
        }

        await recordDeviceKeyChangeWithKysely(
          env.DB,
          userId,
          signedKeyObj.device_id ?? null,
          "update",
        );
      } catch (err) {
        await runClientEffect(
          logger.error("keys.command.error", err, {
            command: "signatures_upload",
            target_user_id: userId,
            key_id: keyId,
          }),
        );
        if (!failures[userId]) failures[userId] = {};
        failures[userId][keyId] = {
          errcode: "M_UNKNOWN",
          error: "Failed to store signature",
        };
      }
    }
  }

  await runClientEffect(
    logger.info("keys.command.success", {
      command: "signatures_upload",
      failure_count: Object.keys(failures).length,
    }),
  );

  return { failures };
}
