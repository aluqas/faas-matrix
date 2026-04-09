// Matrix Homeserver on Cloudflare Workers
// Main entry point

import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import type { AppEnv } from "./shared/types";

// Import API routes
import versions from "./api/versions";
import login from "./api/login";
import rooms from "./api/rooms";
import sync from "./api/sync";
import profile from "./api/profile";
import voip from "./api/voip";
import keys from "./api/keys";
import federation from "./api/federation";
import keyBackups from "./api/key-backups";
import toDevice from "./api/to-device";
import push from "./api/push";
import accountData from "./api/account-data";
import typing from "./api/typing";
import receipts from "./api/receipts";
import tags from "./api/tags";
import devices from "./api/devices";
import presence from "./api/presence";
import aliases from "./api/aliases";
import relations from "./api/relations";
import spaces from "./api/spaces";
import account from "./api/account";
import serverNotices from "./api/server-notices";
import report from "./api/report";
import { validateFilterDefinition } from "./api/filter-validation";
// import qrLogin from './api/qr-login'; // QR feature commented out - requires MSC4108/OIDC for Element X
import { rateLimitMiddleware } from "./infra/middleware/rate-limit";
import { requireAuth } from "./infra/middleware/auth";
import { analyticsMiddleware } from "./infra/middleware/analytics";
import { appContextMiddleware } from "./platform/cloudflare/app-context";
import { FEDERATION_OUTBOUND_DO_NAME } from "./infra/federation/federation-outbound";
import { handleAppError } from "./platform/cloudflare/http-error-handler";

// Import Durable Objects
export {
  RoomDurableObject,
  SyncDurableObject,
  FederationDurableObject,
  CallRoomDurableObject,
  AdminDurableObject,
  UserKeysDurableObject,
  PushDurableObject,
  RateLimitDurableObject,
} from "./platform/durable-objects";

// Import Workflows
export {
  RoomJoinWorkflow,
  PushNotificationWorkflow,
  FederationCatchupWorkflow,
  MediaCleanupWorkflow,
  StateCompactionWorkflow,
} from "./platform/workflows";

// Create the main app
// strict: false normalises trailing slashes so e.g. PUT /state/m.room.join_rules/
// (empty stateKey) matches the /:stateKey? route correctly.
const app = new Hono<AppEnv>({ strict: false });

type LazyRouteModule = { default: { fetch: typeof app.fetch } };

async function dispatchLazyRoute(c: Context<AppEnv>, loader: () => Promise<LazyRouteModule>) {
  const module = await loader();
  return module.default.fetch(c.req.raw, c.env, c.executionCtx);
}

async function renderAdminDashboard(serverName: string): Promise<string> {
  const module = await import("./features/admin/dashboard");
  return module.adminDashboardHtml(serverName);
}

// Minimal readiness endpoint for Complement/startup health checks.
// Keep this before global middleware so deploy/startup probes avoid logger,
// analytics, app-context construction, and rate limiting.
app.get("/_internal/ready", (c) => {
  return c.json({ ready: true, server: "matrix-worker" });
});

// CORS for Matrix clients - MUST BE FIRST to ensure headers are always sent
// (even on error responses from rate limiter or other middleware)
app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "X-Matrix-Origin"],
    exposeHeaders: ["Content-Type", "Content-Length"],
    maxAge: 86400,
  }),
);

// Global middleware
app.use("*", logger());
app.use("*", analyticsMiddleware());
app.use("*", appContextMiddleware());

// Rate limiting for Matrix API endpoints
app.use("/_matrix/*", rateLimitMiddleware);

// Health check
app.get("/health", (c) => c.json({ status: "ok", server: "matrix-worker" }));

// Complement startup hook to re-arm outbound federation retries after a worker restart.
app.post("/_internal/federation/recover", async (c) => {
  const stub = c.env.FEDERATION.get(c.env.FEDERATION.idFromName(FEDERATION_OUTBOUND_DO_NAME));
  await stub.fetch(new Request("http://internal/recover", { method: "POST" }));
  return c.json({ recovered: true });
});

// Admin dashboard - serve HTML with security headers
app.get("/admin", (c) => {
  return renderAdminDashboard(c.env.SERVER_NAME).then((html) =>
    c.html(html, 200, {
      // Content-Security-Policy for XSS protection
      // 'unsafe-inline' is needed for the inline scripts/styles in the dashboard
      // This could be improved by moving scripts to external files with nonces
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "strict-origin-when-cross-origin",
    }),
  );
});

app.get("/admin/", (c) => {
  return renderAdminDashboard(c.env.SERVER_NAME).then((html) =>
    c.html(html, 200, {
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "strict-origin-when-cross-origin",
    }),
  );
});

// Lazily load infrequently-used heavy modules to reduce worker startup cost,
// especially for Complement cold starts.
const loadAdmin = () => import("./api/admin");
const loadOidcAuth = () => import("./api/oidc-auth");
const loadOauth = () => import("./api/oauth");
const loadCalls = () => import("./api/calls");
const loadRtc = () => import("./api/rtc");
const loadAppservice = () => import("./api/appservice");
const loadIdentity = () => import("./api/identity");
const loadSlidingSync = () => import("./api/sliding-sync");
const loadMedia = () => import("./api/media");
const loadSearch = () => import("./api/search");

app.all("/admin/api/*", (c) => dispatchLazyRoute(c, loadAdmin));
app.all("/_synapse/admin/*", (c) => dispatchLazyRoute(c, loadAdmin));
app.all("/_matrix/client/v3/admin/*", (c) => dispatchLazyRoute(c, loadAdmin));

// QR code login landing page - commented out, requires MSC4108/OIDC for Element X
// app.route('/', qrLogin);

// OIDC/SSO authentication
app.all("/auth/oidc/*", (c) => dispatchLazyRoute(c, loadOidcAuth));
app.all("/_matrix/client/v1/auth_metadata", (c) => dispatchLazyRoute(c, loadOidcAuth));

// OAuth 2.0 provider endpoints
app.all("/oauth/*", (c) => dispatchLazyRoute(c, loadOauth));

// Matrix version discovery
app.route("/", versions);

// Client-Server API
app.route("/", login);
app.route("/", rooms);
app.route("/", sync);
app.route("/", profile);
app.route("/", voip);
app.route("/", keys);
app.route("/", keyBackups);
app.route("/", toDevice);
app.route("/", push);
app.route("/", accountData);
app.route("/", typing);
app.route("/", receipts);
app.route("/", tags);
app.route("/", devices);
app.route("/", presence);
app.route("/", aliases);
app.route("/", relations);
app.route("/", spaces);
app.route("/", account);
app.route("/", serverNotices);
app.route("/", report);

app.all("/_matrix/client/unstable/org.matrix.msc3575/sync", (c) =>
  dispatchLazyRoute(c, loadSlidingSync),
);
app.all("/_matrix/client/unstable/org.matrix.simplified_msc3575/sync", (c) =>
  dispatchLazyRoute(c, loadSlidingSync),
);
app.all("/_matrix/client/v4/sync", (c) => dispatchLazyRoute(c, loadSlidingSync));

app.all("/_matrix/media/*", (c) => dispatchLazyRoute(c, loadMedia));
app.all("/_matrix/client/v1/media/*", (c) => dispatchLazyRoute(c, loadMedia));

app.all("/_matrix/client/v3/search", (c) => dispatchLazyRoute(c, loadSearch));

// Cloudflare Calls-based video calling API
app.all("/_matrix/client/v3/rooms/:roomId/call", (c) => dispatchLazyRoute(c, loadCalls));
app.all("/_matrix/client/v3/rooms/:roomId/call/:action", (c) => dispatchLazyRoute(c, loadCalls));
app.all("/calls/*", (c) => dispatchLazyRoute(c, loadCalls));

// MatrixRTC (LiveKit) JWT service for Element X calls
app.all("/_matrix/client/unstable/org.matrix.msc4143/rtc/transports", (c) =>
  dispatchLazyRoute(c, loadRtc),
);
app.all("/livekit/*", (c) => dispatchLazyRoute(c, loadRtc));

// Application Service API
app.all("/_matrix/app/v1/*", (c) => dispatchLazyRoute(c, loadAppservice));

// Identity Service API
app.all("/_matrix/identity/v2", (c) => dispatchLazyRoute(c, loadIdentity));
app.all("/_matrix/identity/v2/*", (c) => dispatchLazyRoute(c, loadIdentity));

// Server-Server (Federation) API
app.route("/", federation);

// Capabilities endpoint
app.get("/_matrix/client/v3/capabilities", requireAuth(), (c) => {
  return c.json({
    capabilities: {
      "m.change_password": {
        enabled: true,
      },
      "m.room_versions": {
        default: "10",
        available: {
          "1": "stable",
          "2": "stable",
          "3": "stable",
          "4": "stable",
          "5": "stable",
          "6": "stable",
          "7": "stable",
          "8": "stable",
          "9": "stable",
          "10": "stable",
          "11": "stable",
          "12": "stable",
        },
      },
      "m.set_displayname": {
        enabled: true,
      },
      "m.set_avatar_url": {
        enabled: true,
      },
      "m.3pid_changes": {
        enabled: true,
      },
    },
  });
});

// Push rules now handled by push.ts

// Filter endpoints - persist filters in KV for sync optimization
app.post("/_matrix/client/v3/user/:userId/filter", requireAuth(), async (c) => {
  const userId = c.get("userId");
  const requestedUserId = c.req.param("userId");

  // Users can only create filters for themselves
  if (userId !== requestedUserId) {
    return c.json({ errcode: "M_FORBIDDEN", error: "Cannot create filters for other users" }, 403);
  }

  let filter: Record<string, unknown>;
  try {
    filter = validateFilterDefinition(await c.req.json());
  } catch (error) {
    if (error instanceof Error && "toResponse" in error) {
      return (error as { toResponse(): Response }).toResponse();
    }
    return c.json({ errcode: "M_BAD_JSON", error: "Invalid JSON" }, 400);
  }

  // Generate filter ID and store in KV
  const filterId = crypto.randomUUID().split("-")[0];
  await c.env.CACHE.put(
    `filter:${userId}:${filterId}`,
    JSON.stringify(filter),
    { expirationTtl: 30 * 24 * 60 * 60 }, // 30 days TTL
  );

  return c.json({ filter_id: filterId });
});

app.get("/_matrix/client/v3/user/:userId/filter/:filterId", requireAuth(), async (c) => {
  const userId = c.get("userId");
  const requestedUserId = c.req.param("userId");
  const filterId = c.req.param("filterId");

  // Users can only read their own filters
  if (userId !== requestedUserId) {
    return c.json({ errcode: "M_FORBIDDEN", error: "Cannot read filters for other users" }, 403);
  }

  const filterJson = await c.env.CACHE.get(`filter:${userId}:${filterId}`);
  if (!filterJson) {
    // Return empty filter if not found (per spec, unknown filter IDs should return empty)
    return c.json({});
  }

  try {
    const filter = JSON.parse(filterJson);
    return c.json(filter);
  } catch {
    return c.json({});
  }
});

// Account data endpoints now handled by account-data.ts

// Presence endpoints now handled by presence.ts

// Search endpoint is lazy-loaded above.

// Typing notifications now handled by typing.ts

// Read receipts now handled by receipts.ts

// Device management now handled by devices.ts

// Public rooms directory
app.get("/_matrix/client/v3/publicRooms", async (c) => {
  const db = c.env.DB;

  const rooms = await db
    .prepare(
      `SELECT r.room_id, r.room_version
     FROM rooms r
     WHERE r.is_public = 1
     LIMIT 100`,
    )
    .all<{ room_id: string; room_version: string }>();

  const publicRooms: any[] = [];

  for (const room of rooms.results) {
    // Get room name and topic from state
    const nameEvent = await db
      .prepare(
        `SELECT e.content FROM room_state rs
       JOIN events e ON rs.event_id = e.event_id
       WHERE rs.room_id = ? AND rs.event_type = 'm.room.name'`,
      )
      .bind(room.room_id)
      .first<{ content: string }>();

    const topicEvent = await db
      .prepare(
        `SELECT e.content FROM room_state rs
       JOIN events e ON rs.event_id = e.event_id
       WHERE rs.room_id = ? AND rs.event_type = 'm.room.topic'`,
      )
      .bind(room.room_id)
      .first<{ content: string }>();

    // Get member count
    const memberCount = await db
      .prepare(
        `SELECT COUNT(*) as count FROM room_memberships WHERE room_id = ? AND membership = 'join'`,
      )
      .bind(room.room_id)
      .first<{ count: number }>();

    publicRooms.push({
      room_id: room.room_id,
      name: nameEvent ? JSON.parse(nameEvent.content).name : undefined,
      topic: topicEvent ? JSON.parse(topicEvent.content).topic : undefined,
      num_joined_members: memberCount?.count ?? 0,
      world_readable: false,
      guest_can_join: false,
    });
  }

  return c.json({
    chunk: publicRooms,
    total_room_count_estimate: publicRooms.length,
  });
});

app.post("/_matrix/client/v3/publicRooms", (c) => {
  // Same as GET but with search/filter support
  return c.json({
    chunk: [],
    total_room_count_estimate: 0,
  });
});

// User directory search (requires authentication per Matrix spec)
app.post("/_matrix/client/v3/user_directory/search", requireAuth(), async (c) => {
  const db = c.env.DB;
  const requestingUserId = c.get("userId");

  let body: { search_term: string; limit?: number };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ errcode: "M_BAD_JSON", error: "Invalid JSON" }, 400);
  }

  const searchTerm = body.search_term || "";
  const limit = Math.min(body.limit ?? 10, 50);

  console.log("[user_directory] Search request:", {
    requestingUserId,
    searchTerm,
    limit,
    userAgent: c.req.header("User-Agent"),
  });

  if (!searchTerm) {
    return c.json({ results: [], limited: false });
  }

  // Search for users using FTS5 for ranked full-text search
  const ftsSearchTerm = searchTerm.replaceAll(/['"*()]/g, " ").trim();
  const results = await db
    .prepare(`
    SELECT u.user_id, u.display_name, u.avatar_url
    FROM users_fts fts
    JOIN users u ON fts.user_id = u.user_id
    WHERE users_fts MATCH ?
      AND u.is_deactivated = 0
      AND u.is_guest = 0
      AND u.user_id != ?
    ORDER BY bm25(users_fts)
    LIMIT ?
  `)
    .bind(ftsSearchTerm, requestingUserId, limit + 1)
    .all<{
      user_id: string;
      display_name: string | null;
      avatar_url: string | null;
    }>();

  const limited = results.results.length > limit;
  // Return explicit null values (not undefined/omitted) so Element X knows user exists
  const users = results.results.slice(0, limit).map((u) => ({
    user_id: u.user_id,
    display_name: u.display_name ?? null,
    avatar_url: u.avatar_url ?? null,
  }));

  console.log("[user_directory] Search results:", {
    searchTerm,
    resultCount: users.length,
    limited,
    firstResult: users[0],
  });

  return c.json({ results: users, limited });
});

// Third-party protocols (stub - no bridges configured)
app.get("/_matrix/client/v3/thirdparty/protocols", (c) => {
  return c.json({});
});

// Dehydrated device (MSC3814 - stub)
app.get("/_matrix/client/unstable/org.matrix.msc3814.v1/dehydrated_device", (c) => {
  return c.json(
    {
      errcode: "M_NOT_FOUND",
      error: "No dehydrated device found",
    },
    404,
  );
});

// OIDC auth metadata endpoints are now handled by oidc-auth.ts
// Legacy unstable endpoint for backwards compatibility
app.get("/_matrix/client/unstable/org.matrix.msc2965/auth_issuer", (c) => {
  // Redirect to the stable endpoint implementation
  return c.redirect("/_matrix/client/v1/auth_metadata", 307);
});

app.get("/_matrix/client/unstable/org.matrix.msc2965/auth_metadata", (c) => {
  // Redirect to the stable endpoint implementation
  return c.redirect("/_matrix/client/v1/auth_metadata", 307);
});

// Fallback for unknown endpoints.
// Matrix API only uses GET, POST, PUT, DELETE, OPTIONS, HEAD.
// Any other method (e.g. PATCH) on a /_matrix/* path → 405 per spec §API Standards.
// Standard methods on unknown paths → 404.
app.all("/_matrix/*", (c) => {
  const method = c.req.method;
  const standardMethods = new Set(["GET", "POST", "PUT", "DELETE", "OPTIONS", "HEAD"]);
  if (!standardMethods.has(method)) {
    return c.json({ errcode: "M_UNRECOGNIZED", error: "Method not allowed" }, 405);
  }
  return c.json({ errcode: "M_UNRECOGNIZED", error: "Unrecognized request" }, 404);
});

// 404 handler
app.notFound((c) => {
  return c.json({ error: "Not found" }, 404);
});

app.onError(handleAppError);

export default app;
