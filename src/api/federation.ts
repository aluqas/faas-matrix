import { Hono } from "hono";
import type { AppEnv } from "../shared/types";
import { Errors } from "../shared/utils/errors";
import { requireFederationAuth } from "../infra/middleware/federation-auth";
import federationQueryRoutes from "./federation/query";
import federationSpaceRoutes from "./federation/spaces";
import federationTransactionRoutes from "./federation/transaction";
import federationEventsRoutes from "./federation/events";
import federationMembershipRoutes from "./federation/membership";
import federationE2eeRoutes from "./federation/e2ee";
import {
  queryCurrentLocalServerKeys,
  queryLocalServerKeyById,
} from "../features/federation-query/local-server-keys";
import {
  loadFederationMediaDownload,
  loadFederationMediaThumbnail,
} from "../features/federation-query/media";
import { queryFederationPublicRooms } from "../features/federation-query/public-rooms";

const app = new Hono<AppEnv>();

type OpenIdTokenData = {
  user_id: string;
  expires_at: number;
};

function parseOpenIdTokenData(value: unknown): OpenIdTokenData | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const data = value as { user_id?: unknown; expires_at?: unknown };
  return typeof data.user_id === "string" && typeof data.expires_at === "number"
    ? {
        user_id: data.user_id,
        expires_at: data.expires_at,
      }
    : null;
}

function methodNotAllowedJson(): Response {
  return new Response(
    JSON.stringify({
      errcode: "M_UNRECOGNIZED",
      error: "Method not allowed",
    }),
    {
      status: 405,
      headers: {
        "Content-Type": "application/json",
      },
    },
  );
}

app.get("/_matrix/federation/v1/version", (c) => {
  return c.json({
    server: {
      name: "matrix-worker",
      version: c.env.SERVER_VERSION || "0.1.0",
    },
  });
});

app.on(["POST", "PUT", "DELETE", "PATCH"], "/_matrix/federation/v1/version", () =>
  methodNotAllowedJson(),
);

app.use("/_matrix/federation/v1/:endpoint", async (c, next) => {
  if (c.req.param("endpoint") === "version") {
    await next();
    return;
  }
  return c.json({ errcode: "M_UNRECOGNIZED", error: "Unrecognized request" }, 404);
});

app.use("/_matrix/federation/v1/*", requireFederationAuth());
app.use("/_matrix/federation/v2/*", requireFederationAuth());
app.use("/_matrix/federation/unstable/*", requireFederationAuth());

app.route("/", federationQueryRoutes);
app.route("/", federationSpaceRoutes);
app.route("/", federationTransactionRoutes);
app.route("/", federationEventsRoutes);
app.route("/", federationMembershipRoutes);
app.route("/", federationE2eeRoutes);

app.get("/_matrix/key/v2/server", (c) => {
  return queryCurrentLocalServerKeys(c.env);
});

app.get("/_matrix/key/v2/server/:keyId", async (c) => {
  const keyId = c.req.param("keyId");
  const response = await queryLocalServerKeyById(c.env, keyId);
  if (!response) {
    return Errors.notFound("Key not found").toResponse();
  }
  return response;
});

app.get("/_matrix/federation/v1/media/download/:mediaId", async (c) => {
  const payload = await loadFederationMediaDownload({
    env: c.env,
    mediaId: c.req.param("mediaId"),
  });
  if (!payload) {
    return Errors.notFound("Media not found").toResponse();
  }

  const headers = new Headers();
  headers.set("Content-Type", payload.contentType);
  if (payload.filename) {
    headers.set("Content-Disposition", `inline; filename="${payload.filename}"`);
  }
  headers.set("Cache-Control", "public, max-age=31536000, immutable");

  return new Response(payload.object.body, { headers });
});

app.get("/_matrix/federation/v1/media/thumbnail/:mediaId", async (c) => {
  const mediaId = c.req.param("mediaId");
  const width = Math.min(Number.parseInt(c.req.query("width") ?? "96", 10), 1920);
  const height = Math.min(Number.parseInt(c.req.query("height") ?? "96", 10), 1920);
  const method = c.req.query("method") ?? "scale";
  const payload = await loadFederationMediaThumbnail({
    env: c.env,
    mediaId,
    width,
    height,
    method,
  });
  if (!payload) {
    return Errors.notFound("Media not found").toResponse();
  }
  if (payload.kind === "cached") {
    const headers = new Headers();
    headers.set("Content-Type", "image/jpeg");
    headers.set("Cache-Control", "public, max-age=31536000, immutable");
    return new Response(payload.object.body, { headers });
  }

  const headers = new Headers();
  headers.set("Content-Type", payload.contentType);
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  if (payload.contentType.startsWith("image/")) {
    headers.set("X-Thumbnail-Generated", "false");
  }

  return new Response(payload.object.body, { headers });
});

app.get("/_matrix/federation/v1/publicRooms", async (c) => {
  const limit = Math.min(Number.parseInt(c.req.query("limit") ?? "100", 10), 500);
  const since = c.req.query("since");
  void c.req.query("include_all_networks");

  let offset = 0;
  if (since && since.startsWith("offset_")) {
    offset = Number.parseInt(since.slice(7), 10) || 0;
  }

  const response = await queryFederationPublicRooms({
    db: c.env.DB,
    limit,
    offset,
  });
  return c.json({
    chunk: response.chunk,
    total_room_count_estimate: response.totalRoomCountEstimate,
    ...(response.nextBatch ? { next_batch: response.nextBatch } : {}),
    ...(response.prevBatch ? { prev_batch: response.prevBatch } : {}),
  });
});

app.post("/_matrix/federation/v1/publicRooms", async (c) => {
  let body: {
    limit?: number;
    since?: string;
    filter?: { generic_search_term?: string };
    include_all_networks?: boolean;
  };

  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  const limit = Math.min(body.limit ?? 100, 500);
  const since = body.since;
  const searchTerm = body.filter?.generic_search_term?.toLowerCase();

  let offset = 0;
  if (since && since.startsWith("offset_")) {
    offset = Number.parseInt(since.slice(7), 10) || 0;
  }

  const response = await queryFederationPublicRooms({
    db: c.env.DB,
    limit,
    offset,
    searchTerm,
  });
  return c.json({
    chunk: response.chunk,
    total_room_count_estimate: response.totalRoomCountEstimate,
    ...(response.nextBatch ? { next_batch: response.nextBatch } : {}),
    ...(response.prevBatch ? { prev_batch: response.prevBatch } : {}),
  });
});

app.get("/_matrix/federation/v1/openid/userinfo", async (c) => {
  const accessToken = c.req.query("access_token");
  if (!accessToken) {
    return Errors.missingParam("access_token").toResponse();
  }

  const tokenData = parseOpenIdTokenData(await c.env.SESSIONS.get(`openid:${accessToken}`, "json"));
  if (!tokenData) {
    return c.json(
      {
        errcode: "M_UNKNOWN_TOKEN",
        error: "Invalid or expired OpenID token",
      },
      401,
    );
  }

  if (Date.now() > tokenData.expires_at) {
    await c.env.SESSIONS.delete(`openid:${accessToken}`);
    return c.json(
      {
        errcode: "M_UNKNOWN_TOKEN",
        error: "OpenID token has expired",
      },
      401,
    );
  }

  return c.json({
    sub: tokenData.user_id,
  });
});

export default app;
