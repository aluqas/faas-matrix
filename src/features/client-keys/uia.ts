import { Errors, MatrixApiError } from "../../shared/utils/errors";
import { toUserId } from "../../shared/utils/ids";
import { getUserPasswordHash, hasIdentityProviderLink } from "../../infra/repositories/user-auth-repository";
import type { TokenSubmitRequest, UIAAuthDict, UiaSessionData } from "../../shared/types/client";
import { parseUiaSessionData } from "../../api/keys-contracts";

const UIA_SESSION_TTL_SECONDS = 300;

export function parseUiaSessionJson(value: string): UiaSessionData | null {
  try {
    return parseUiaSessionData(JSON.parse(value));
  } catch {
    return null;
  }
}

export function isOidcUser(db: D1Database, userId: string): Promise<boolean> {
  const typedUserId = toUserId(userId);
  if (!typedUserId) {
    return Promise.resolve(false);
  }
  return hasIdentityProviderLink(db, typedUserId);
}

export async function hasPassword(db: D1Database, userId: string): Promise<boolean> {
  const typedUserId = toUserId(userId);
  if (!typedUserId) {
    return false;
  }

  const hash = await getUserPasswordHash(db, typedUserId);
  return hash !== null && hash.length > 0;
}

export async function loadUiaSession(
  cache: KVNamespace,
  sessionId: string,
): Promise<UiaSessionData | null> {
  const sessionJson = await cache.get(`uia_session:${sessionId}`);
  if (!sessionJson) {
    return null;
  }
  return parseUiaSessionJson(sessionJson);
}

export async function persistUiaSession(
  cache: KVNamespace,
  sessionId: string,
  session: UiaSessionData,
): Promise<void> {
  await cache.put(`uia_session:${sessionId}`, JSON.stringify(session), {
    expirationTtl: UIA_SESSION_TTL_SECONDS,
  });
}

export async function deleteUiaSession(cache: KVNamespace, sessionId: string): Promise<void> {
  await cache.delete(`uia_session:${sessionId}`);
}

export async function initializeCrossSigningUiaSession(input: {
  cache: KVNamespace;
  sessionId: string;
  userId: string;
  isOidcUser: boolean;
  hasPassword: boolean;
}): Promise<void> {
  const typedUserId = toUserId(input.userId);
  if (!typedUserId) {
    throw Errors.unauthorized();
  }
  await persistUiaSession(input.cache, input.sessionId, {
    user_id: typedUserId,
    created_at: Date.now(),
    type: "device_signing_upload",
    completed_stages: [],
    is_oidc_user: input.isOidcUser,
    has_password: input.hasPassword,
  });
}

export function buildCrossSigningUiaChallenge(input: {
  serverName: string;
  sessionId: string;
  isOidcUser: boolean;
  hasPassword: boolean;
}): {
  flows: Array<{ stages: string[] }>;
  params: Record<string, Record<string, string>>;
  session: string;
} {
  const flows: Array<{ stages: string[] }> = [];
  const baseUrl = `https://${input.serverName}`;
  const params: Record<string, Record<string, string>> = {};

  if (input.isOidcUser) {
    const unstableStage = "org.matrix.cross_signing_reset";
    const stableStage = "m.oauth";
    flows.push({ stages: [unstableStage] });
    flows.push({ stages: [stableStage] });
    const approvalUrl = `${baseUrl}/oauth/authorize/uia?session=${input.sessionId}&action=org.matrix.cross_signing_reset`;
    params[unstableStage] = { url: approvalUrl };
    params[stableStage] = { url: approvalUrl };
  }

  if (input.hasPassword) {
    flows.push({ stages: ["m.login.password"] });
  }

  if (flows.length === 0) {
    flows.push({ stages: ["m.login.password"] });
  }

  return {
    flows,
    params,
    session: input.sessionId,
  };
}

export function buildSsoAuthorizeUrl(serverName: string, sessionId: string): string {
  const baseUrl = `https://${serverName}`;
  const authorizeUrl = new URL(`${baseUrl}/oauth/authorize`);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", "matrix-uia");
  authorizeUrl.searchParams.set(
    "redirect_uri",
    `${baseUrl}/_matrix/client/v3/auth/m.login.sso/callback`,
  );
  authorizeUrl.searchParams.set("scope", "openid");
  authorizeUrl.searchParams.set("state", sessionId);
  return authorizeUrl.toString();
}

export async function prepareUiaSsoRedirect(input: {
  cache: KVNamespace;
  serverName: string;
  sessionId: string;
  redirectUrl?: string;
}): Promise<string> {
  const session = await loadUiaSession(input.cache, input.sessionId);
  if (!session) {
    throw Errors.unknown("UIA session not found or expired");
  }

  const baseUrl = `https://${input.serverName}`;
  session.redirect_url =
    input.redirectUrl ?? `${baseUrl}/_matrix/client/v3/auth/m.login.sso/callback`;
  await persistUiaSession(input.cache, input.sessionId, session);
  return buildSsoAuthorizeUrl(input.serverName, input.sessionId);
}

export async function completeUiaSsoCallback(input: {
  cache: KVNamespace;
  sessionId: string;
}): Promise<UiaSessionData> {
  const session = await loadUiaSession(input.cache, input.sessionId);
  if (!session) {
    throw Errors.unknown("The UIA session has expired. Please try again.");
  }

  session.completed_stages = session.completed_stages ?? [];
  if (!session.completed_stages.includes("m.login.sso")) {
    session.completed_stages.push("m.login.sso");
  }
  session.sso_completed_at = Date.now();
  await persistUiaSession(input.cache, input.sessionId, session);
  return session;
}

export async function submitUiaToken(input: {
  cache: KVNamespace;
  userId: string;
  request: TokenSubmitRequest;
}): Promise<{ completed: string[]; session: string }> {
  const { userId, request } = input;
  const sessionId = request.session;
  if (!sessionId) {
    throw Errors.missingParam("session");
  }

  const sessionData = await loadUiaSession(input.cache, sessionId);
  if (!sessionData) {
    throw new MatrixApiError("M_UNKNOWN", "UIA session not found or expired", 404);
  }
  if (sessionData.user_id !== userId) {
    throw Errors.forbidden("Session user mismatch");
  }

  sessionData.completed_stages = sessionData.completed_stages ?? [];
  if (!sessionData.completed_stages.includes("m.login.token")) {
    sessionData.completed_stages.push("m.login.token");
  }
  sessionData.token_completed_at = Date.now();

  await persistUiaSession(input.cache, sessionId, sessionData);
  return {
    completed: ["m.login.token"],
    session: sessionId,
  };
}

export function assertCompletedUiaAuth(
  userId: string,
  session: UiaSessionData | null,
  auth: UIAAuthDict,
): void {
  if (!auth.session) {
    throw Errors.missingParam("auth.session");
  }
  if (!session) {
    throw new MatrixApiError("M_UNKNOWN", "UIA session not found or expired", 401);
  }
  if (session.user_id !== userId) {
    throw Errors.forbidden("Session user mismatch");
  }

  const completedStages = session.completed_stages ?? [];
  const hasOAuthApproval =
    completedStages.includes("org.matrix.cross_signing_reset") ||
    completedStages.includes("m.oauth") ||
    completedStages.includes("m.login.oauth") ||
    completedStages.includes("m.login.sso") ||
    completedStages.includes("m.login.token");

  if (!hasOAuthApproval) {
    throw new MatrixApiError(
      "M_UNAUTHORIZED",
      "Cross-signing reset not approved. Please approve the request at the provided URL.",
      401,
    );
  }
}

export function generateSSOErrorPage(title: string, message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #f1f5f9; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .container { background: #1e293b; padding: 40px; border-radius: 12px; max-width: 400px; text-align: center; border: 1px solid #334155; }
    h1 { color: #ef4444; margin-bottom: 16px; }
    p { color: #94a3b8; margin-bottom: 24px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>${title}</h1>
    <p>${message}</p>
    <p>You can close this window and try again.</p>
  </div>
</body>
</html>`;
}

export function generateSSOSuccessPage(sessionId: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Authentication Successful</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #f1f5f9; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .container { background: #1e293b; padding: 40px; border-radius: 12px; max-width: 400px; text-align: center; border: 1px solid #334155; }
    h1 { color: #22c55e; margin-bottom: 16px; }
    p { color: #94a3b8; margin-bottom: 24px; }
    .session { font-family: monospace; background: #0f172a; padding: 8px 16px; border-radius: 8px; font-size: 12px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Authentication Successful</h1>
    <p>Your identity has been verified.</p>
    <p>You can now return to your Matrix client and complete the operation.</p>
    <p class="session">Session: ${sessionId}</p>
    <script>
      if (window.opener) {
        window.opener.postMessage({ type: 'uia_complete', session: '${sessionId}' }, '*');
        setTimeout(() => window.close(), 2000);
      }
    </script>
  </div>
</body>
</html>`;
}
