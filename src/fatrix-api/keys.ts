// Matrix key management endpoints (E2EE)
// Implements: https://spec.matrix.org/v1.12/client-server-api/#end-to-end-encryption
//
// This module handles:
// - Device key upload/query
// - One-time key management
// - Cross-signing keys (master, self-signing, user-signing)
// - Key change tracking
//
// IMPORTANT: Cross-signing keys use Durable Objects for strong consistency.
// Per the Cloudflare blog: "Some operations can't tolerate eventual consistency"
// D1 has eventual consistency across read replicas, which breaks E2EE bootstrap.

import { Hono } from "hono";
import type { AppEnv } from "./hono-env";
import { Errors, MatrixApiError } from "../fatrix-model/utils/errors";
import { requireAuth } from "./middleware/auth";
import { runClientEffect } from "../fatrix-backend/application/runtime/effect-runtime";
import {
  encodeClientKeysChangesResponse,
  encodeClientKeysClaimResponse,
  encodeClientKeysQueryResponse,
  encodeClientKeysSignaturesUploadResponse,
  encodeClientKeysUploadResponse,
} from "../fatrix-backend/application/features/e2ee-shared/encoder";
import { uploadClientKeys } from "../fatrix-backend/application/features/client-keys/upload";
import { queryClientKeyChanges, queryClientKeys } from "../fatrix-backend/application/features/client-keys/query";
import { claimClientKeys } from "../fatrix-backend/application/features/client-keys/claim";
import { createKeysLogger } from "../fatrix-backend/application/features/client-keys/shared";
import {
  generateSSOErrorPage,
  generateSSOSuccessPage,
  prepareUiaSsoRedirect,
  submitUiaToken,
  loadUiaSession,
  completeUiaSsoCallback,
} from "../fatrix-backend/application/features/client-keys/uia";
import { uploadCrossSigningKeys, uploadKeySignatures } from "../fatrix-backend/application/features/client-keys/cross-signing";
import {
  type SignaturesUploadRequest,
  type TokenSubmitRequest,
  parseCrossSigningUploadRequest,
  parseKeysClaimRequest,
  parseKeysQueryRequest,
  parseKeysUploadRequest,
  parseSignaturesUploadRequest,
  parseTokenSubmitRequest,
} from "../fatrix-model/types/keys-contracts";

const app = new Hono<AppEnv>();

// ============================================
// Device Keys
// ============================================

// POST /_matrix/client/v3/keys/upload - Upload device keys and one-time keys
app.post("/_matrix/client/v3/keys/upload", requireAuth(), async (c) => {
  const userId = c.get("userId");
  const deviceId = c.get("deviceId");

  if (!userId || !deviceId) {
    return Errors.unauthorized().toResponse();
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  const parsed = parseKeysUploadRequest(body);
  if (!parsed) {
    return Errors.badJson().toResponse();
  }

  try {
    const { oneTimeKeyCounts } = await uploadClientKeys({
      env: c.env,
      userId,
      deviceId,
      request: parsed,
    });
    return c.json(encodeClientKeysUploadResponse(oneTimeKeyCounts));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("device_keys.user_id")) {
      return c.json({ errcode: "M_INVALID_PARAM", error: error.message }, 400);
    }
    throw error;
  }
});

// POST /_matrix/client/v3/keys/query - Query device keys for users
app.post("/_matrix/client/v3/keys/query", requireAuth(), async (c) => {
  const requesterUserId = c.get("userId");

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  const parsed = parseKeysQueryRequest(body);
  if (!parsed) {
    return Errors.badJson().toResponse();
  }
  const { deviceKeys, masterKeys, selfSigningKeys, userSigningKeys, failures } =
    await queryClientKeys({
      env: c.env,
      requesterUserId,
      request: parsed,
    });

  return c.json(
    encodeClientKeysQueryResponse({
      deviceKeys,
      masterKeys,
      selfSigningKeys,
      userSigningKeys,
      failures,
    }),
  );
});

// POST /_matrix/client/v3/keys/claim - Claim one-time keys for establishing sessions
app.post("/_matrix/client/v3/keys/claim", requireAuth(), async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  const parsed = parseKeysClaimRequest(body);
  if (!parsed) {
    return Errors.badJson().toResponse();
  }
  const { oneTimeKeys, failures } = await claimClientKeys({
    env: c.env,
    userId: c.get("userId"),
    request: parsed,
  });

  return c.json(encodeClientKeysClaimResponse(oneTimeKeys, failures));
});

// GET /_matrix/client/v3/keys/changes - Get users whose keys have changed
app.get("/_matrix/client/v3/keys/changes", requireAuth(), async (c) => {
  const userId = c.get("userId");
  const from = c.req.query("from");
  const to = c.req.query("to");
  const db = c.env.DB;

  if (!userId) {
    return Errors.unauthorized().toResponse();
  }

  if (!from || !to) {
    return Errors.missingParam("from and to required").toResponse();
  }
  const { changed, left } = await queryClientKeyChanges({
    db,
    userId,
    from,
    to,
  });

  return c.json(encodeClientKeysChangesResponse(changed, left));
});

// POST /_matrix/client/v3/keys/device_signing/upload - Upload cross-signing keys
// Spec: https://spec.matrix.org/v1.12/client-server-api/#post_matrixclientv3keysdevice_signingupload
// This endpoint requires UIA (User-Interactive Authentication)
//
// For OIDC users (users linked to external IdP), we support:
// - m.login.sso: Redirect to OAuth authorize for re-authentication
// - m.login.token: Token-based authentication (fallback)
// For password users, we support:
// - m.login.password: Password-based authentication
app.post("/_matrix/client/v3/keys/device_signing/upload", requireAuth(), async (c) => {
  const userId = c.get("userId");
  if (!userId) {
    return Errors.unauthorized().toResponse();
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  const parsed = parseCrossSigningUploadRequest(body);
  if (!parsed) {
    return Errors.badJson().toResponse();
  }
  try {
    const outcome = await uploadCrossSigningKeys({
      env: c.env,
      userId,
      request: parsed,
    });
    return c.json(outcome.body, outcome.status);
  } catch (error) {
    if (error instanceof MatrixApiError) {
      return error.toResponse();
    }
    throw error;
  }
});

// POST /_matrix/client/v3/keys/signatures/upload - Upload signatures for keys
// Spec: https://spec.matrix.org/v1.12/client-server-api/#post_matrixclientv3keyssignaturesupload
// Body format: { user_id: { key_id: signed_key_object } }
// - For device keys, key_id is the device_id (e.g., "JLAFKJWSCS")
// - For cross-signing keys, key_id is the base64 public key
app.post("/_matrix/client/v3/keys/signatures/upload", requireAuth(), async (c) => {
  const signerUserId = c.get("userId");

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  const parsedBody: SignaturesUploadRequest | null = parseSignaturesUploadRequest(body);
  if (!parsedBody) {
    return Errors.badJson().toResponse();
  }
  const { failures } = await uploadKeySignatures({
    env: c.env,
    signerUserId,
    request: parsedBody,
  });
  return c.json(encodeClientKeysSignaturesUploadResponse(failures));
});

// ============================================
// UIA SSO Flow Endpoints (for OIDC users)
// ============================================

// GET /_matrix/client/v3/auth/m.login.sso/redirect - Redirect to SSO for UIA
// This endpoint is used by clients to initiate SSO authentication during UIA
// Spec: https://spec.matrix.org/v1.12/client-server-api/#get_matrixclientv3authmlloginssofallbackweb
app.get("/_matrix/client/v3/auth/m.login.sso/redirect", async (c) => {
  const logger = createKeysLogger("uia_sso_redirect");
  const sessionId = c.req.query("session");
  const redirectUrl = c.req.query("redirectUrl");

  if (!sessionId) {
    return c.json(
      {
        errcode: "M_MISSING_PARAM",
        error: "Missing session parameter",
      },
      400,
    );
  }

  // Verify the UIA session exists
  try {
    const authorizeUrl = await prepareUiaSsoRedirect({
      cache: c.env.CACHE,
      serverName: c.env.SERVER_NAME,
      sessionId,
      redirectUrl: redirectUrl ?? undefined,
    });

    await runClientEffect(
      logger.info("keys.command.start", {
        command: "uia_sso_redirect",
        session_id: sessionId,
      }),
    );
    return c.redirect(authorizeUrl);
  } catch (error) {
    if (error instanceof MatrixApiError) {
      return error.toResponse();
    }
    throw error;
  }
});

// GET /_matrix/client/v3/auth/m.login.sso/callback - SSO callback for UIA
// This endpoint handles the return from SSO authentication
app.get("/_matrix/client/v3/auth/m.login.sso/callback", async (c) => {
  const logger = createKeysLogger("uia_sso_callback");
  const code = c.req.query("code");
  const state = c.req.query("state"); // This is the UIA session ID
  const error = c.req.query("error");
  const errorDescription = c.req.query("error_description");

  if (error) {
    await runClientEffect(
      logger.warn("keys.command.sso_error", {
        error_code: error,
        error_description: errorDescription,
      }),
    );
    return c.html(generateSSOErrorPage("SSO Authentication Failed", errorDescription ?? error));
  }

  if (!state) {
    return c.html(generateSSOErrorPage("Invalid Request", "Missing state parameter"));
  }

  // Retrieve the UIA session
  // If code is present, SSO was successful
  // For UIA purposes, we just need to verify the user authenticated - we don't need the token
  if (code) {
    try {
      await completeUiaSsoCallback({
        cache: c.env.CACHE,
        sessionId: state,
      });

      await runClientEffect(
        logger.info("keys.command.success", {
          command: "uia_sso_callback",
          session_id: state,
        }),
      );

      return c.html(generateSSOSuccessPage(state));
    } catch {
      return c.html(
        generateSSOErrorPage("Session Expired", "The UIA session has expired. Please try again."),
      );
    }
  }

  return c.html(generateSSOErrorPage("Authentication Failed", "No authorization code received"));
});

// POST /_matrix/client/v3/auth/m.login.token/submit - Submit token for UIA
// Alternative flow for OIDC users who have a valid token
app.post("/_matrix/client/v3/auth/m.login.token/submit", requireAuth(), async (c) => {
  const userId = c.get("userId");
  const logger = createKeysLogger("uia_token_submit", { user_id: userId });

  if (!userId) {
    return Errors.unauthorized().toResponse();
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  const parsed: TokenSubmitRequest | null = parseTokenSubmitRequest(body);
  if (!parsed) {
    return Errors.badJson().toResponse();
  }

  const { session } = parsed;

  if (!session) {
    return Errors.missingParam("session").toResponse();
  }

  const sessionData = await loadUiaSession(c.env.CACHE, session);
  if (!sessionData) {
    return c.json(
      {
        errcode: "M_UNKNOWN",
        error: "UIA session not found or expired",
      },
      404,
    );
  }

  try {
    const result = await submitUiaToken({
      cache: c.env.CACHE,
      userId,
      request: parsed,
    });

    await runClientEffect(
      logger.info("keys.command.success", {
        command: "uia_token_submit",
        session_id: session,
      }),
    );

    return c.json(result);
  } catch (error) {
    if (error instanceof MatrixApiError) {
      return error.toResponse();
    }
    throw error;
  }
});

export default app;
