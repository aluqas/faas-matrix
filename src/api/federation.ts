import { Hono } from "hono";
import type { AppEnv } from "../types";
import { Errors } from "../utils/errors";
import {
  canonicalJson,
  generateSigningKeyPair,
  normalizeMatrixBase64,
  signJson,
} from "../utils/crypto";
import { requireFederationAuth } from "../middleware/federation-auth";
import { getServerSigningKey, type ServerKeyResponse } from "../services/federation-keys";
import federationQueryRoutes from "./federation/query";
import federationSpaceRoutes from "./federation/spaces";
import federationTransactionRoutes from "./federation/transaction";
import federationEventsRoutes from "./federation/events";
import federationMembershipRoutes from "./federation/membership";
import federationE2eeRoutes from "./federation/e2ee";

const app = new Hono<AppEnv>();

function canonicalJsonResponse(body: Record<string, unknown>): Response {
  return new Response(canonicalJson(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
    },
  });
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

app.get("/_matrix/federation/v1/version", async (c) => {
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

app.get("/_matrix/key/v2/server", async (c) => {
  const serverName = c.env.SERVER_NAME;

  let keys = await c.env.DB.prepare(
    `SELECT key_id, public_key, private_key_jwk, key_version, valid_from, valid_until
     FROM server_keys WHERE is_current = 1 ORDER BY key_version DESC`,
  ).all<{
    key_id: string;
    public_key: string;
    private_key_jwk: string | null;
    key_version: number | null;
    valid_from: number;
    valid_until: number | null;
  }>();

  const hasSecureKey = keys.results.some((key) => key.key_version === 2 && key.private_key_jwk);
  if (keys.results.length === 0 || !hasSecureKey) {
    const keyPair = await generateSigningKeyPair();
    const validFrom = Date.now();
    const validUntil = validFrom + 365 * 24 * 60 * 60 * 1000;

    await c.env.DB.prepare(`UPDATE server_keys SET is_current = 0`).run();
    await c.env.DB.prepare(
      `INSERT INTO server_keys (key_id, public_key, private_key, private_key_jwk, key_version, valid_from, valid_until, is_current)
       VALUES (?, ?, ?, ?, 2, ?, ?, 1)`,
    )
      .bind(
        keyPair.keyId,
        keyPair.publicKey,
        JSON.stringify(keyPair.privateKeyJwk),
        JSON.stringify(keyPair.privateKeyJwk),
        validFrom,
        validUntil,
      )
      .run();

    keys = {
      results: [
        {
          key_id: keyPair.keyId,
          public_key: keyPair.publicKey,
          private_key_jwk: JSON.stringify(keyPair.privateKeyJwk),
          key_version: 2,
          valid_from: validFrom,
          valid_until: validUntil,
        },
      ],
      success: true,
      meta: {
        duration: 0,
        size_after: 0,
        rows_read: 0,
        rows_written: 0,
        last_row_id: 0,
        changed_db: false,
        changes: 0,
      },
    };
  }

  const verifyKeys: Record<string, { key: string }> = {};
  for (const key of keys.results) {
    verifyKeys[key.key_id] = { key: normalizeMatrixBase64(key.public_key) };
  }

  const response = {
    server_name: serverName,
    valid_until_ts: keys.results[0]?.valid_until || Date.now() + 365 * 24 * 60 * 60 * 1000,
    verify_keys: verifyKeys,
    old_verify_keys: {},
  };

  const currentKey = keys.results.find((key) => key.key_version === 2 && key.private_key_jwk);
  if (currentKey && currentKey.private_key_jwk) {
    const signed = await signJson(
      response,
      serverName,
      currentKey.key_id,
      JSON.parse(currentKey.private_key_jwk),
    );
    return canonicalJsonResponse(signed);
  }

  return canonicalJsonResponse(response);
});

app.get("/_matrix/key/v2/server/:keyId", async (c) => {
  const keyId = c.req.param("keyId");
  const serverName = c.env.SERVER_NAME;

  const key = await c.env.DB.prepare(
    `SELECT key_id, public_key, valid_from, valid_until FROM server_keys WHERE key_id = ?`,
  )
    .bind(keyId)
    .first<{
      key_id: string;
      public_key: string;
      valid_from: number;
      valid_until: number | null;
    }>();

  if (!key) {
    return Errors.notFound("Key not found").toResponse();
  }

  const response: ServerKeyResponse = {
    server_name: serverName,
    valid_until_ts: key.valid_until || Date.now() + 365 * 24 * 60 * 60 * 1000,
    verify_keys: {
      [key.key_id]: { key: normalizeMatrixBase64(key.public_key) },
    },
    old_verify_keys: {},
  };

  const signingKey = await getServerSigningKey(c.env.DB);
  if (signingKey) {
    const signed = (await signJson(
      response,
      serverName,
      signingKey.keyId,
      signingKey.privateKeyJwk,
    )) as ServerKeyResponse;
    return canonicalJsonResponse(signed);
  }

  return canonicalJsonResponse(response);
});

app.get("/_matrix/federation/v1/media/download/:mediaId", async (c) => {
  const mediaId = c.req.param("mediaId");
  const object = await c.env.MEDIA.get(mediaId);
  if (!object) {
    return Errors.notFound("Media not found").toResponse();
  }

  const metadata = await c.env.DB.prepare(
    `SELECT content_type, filename FROM media WHERE media_id = ?`,
  )
    .bind(mediaId)
    .first<{ content_type: string; filename: string | null }>();

  const headers = new Headers();
  headers.set("Content-Type", metadata?.content_type || "application/octet-stream");
  if (metadata?.filename) {
    headers.set("Content-Disposition", `inline; filename="${metadata.filename}"`);
  }
  headers.set("Cache-Control", "public, max-age=31536000, immutable");

  return new Response(object.body, { headers });
});

app.get("/_matrix/federation/v1/media/thumbnail/:mediaId", async (c) => {
  const mediaId = c.req.param("mediaId");
  const width = Math.min(Number.parseInt(c.req.query("width") || "96", 10), 1920);
  const height = Math.min(Number.parseInt(c.req.query("height") || "96", 10), 1920);
  const method = c.req.query("method") || "scale";

  const metadata = await c.env.DB.prepare(`SELECT content_type FROM media WHERE media_id = ?`)
    .bind(mediaId)
    .first<{ content_type: string }>();
  if (!metadata) {
    return Errors.notFound("Media not found").toResponse();
  }

  const thumbnailKey = `thumb_${mediaId}_${width}x${height}_${method}`;
  const existingThumb = await c.env.MEDIA.get(thumbnailKey);
  if (existingThumb) {
    const headers = new Headers();
    headers.set("Content-Type", "image/jpeg");
    headers.set("Cache-Control", "public, max-age=31536000, immutable");
    return new Response(existingThumb.body, { headers });
  }

  const object = await c.env.MEDIA.get(mediaId);
  if (!object) {
    return Errors.notFound("Media not found").toResponse();
  }

  const headers = new Headers();
  headers.set("Content-Type", metadata.content_type);
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  if (metadata.content_type.startsWith("image/")) {
    headers.set("X-Thumbnail-Generated", "false");
  }

  return new Response(object.body, { headers });
});

async function getRoomPublicInfo(db: D1Database, roomId: string): Promise<any> {
  const [
    nameEvent,
    topicEvent,
    aliasEvent,
    avatarEvent,
    joinRuleEvent,
    historyEvent,
    guestEvent,
    memberCount,
    createEvent,
  ] = await Promise.all([
    db
      .prepare(
        `SELECT e.content FROM room_state rs
         JOIN events e ON rs.event_id = e.event_id
         WHERE rs.room_id = ? AND rs.event_type = 'm.room.name'`,
      )
      .bind(roomId)
      .first<{ content: string }>(),
    db
      .prepare(
        `SELECT e.content FROM room_state rs
         JOIN events e ON rs.event_id = e.event_id
         WHERE rs.room_id = ? AND rs.event_type = 'm.room.topic'`,
      )
      .bind(roomId)
      .first<{ content: string }>(),
    db
      .prepare(
        `SELECT e.content FROM room_state rs
         JOIN events e ON rs.event_id = e.event_id
         WHERE rs.room_id = ? AND rs.event_type = 'm.room.canonical_alias'`,
      )
      .bind(roomId)
      .first<{ content: string }>(),
    db
      .prepare(
        `SELECT e.content FROM room_state rs
         JOIN events e ON rs.event_id = e.event_id
         WHERE rs.room_id = ? AND rs.event_type = 'm.room.avatar'`,
      )
      .bind(roomId)
      .first<{ content: string }>(),
    db
      .prepare(
        `SELECT e.content FROM room_state rs
         JOIN events e ON rs.event_id = e.event_id
         WHERE rs.room_id = ? AND rs.event_type = 'm.room.join_rules'`,
      )
      .bind(roomId)
      .first<{ content: string }>(),
    db
      .prepare(
        `SELECT e.content FROM room_state rs
         JOIN events e ON rs.event_id = e.event_id
         WHERE rs.room_id = ? AND rs.event_type = 'm.room.history_visibility'`,
      )
      .bind(roomId)
      .first<{ content: string }>(),
    db
      .prepare(
        `SELECT e.content FROM room_state rs
         JOIN events e ON rs.event_id = e.event_id
         WHERE rs.room_id = ? AND rs.event_type = 'm.room.guest_access'`,
      )
      .bind(roomId)
      .first<{ content: string }>(),
    db
      .prepare(
        `SELECT COUNT(*) as count FROM room_memberships WHERE room_id = ? AND membership = 'join'`,
      )
      .bind(roomId)
      .first<{ count: number }>(),
    db
      .prepare(
        `SELECT e.content FROM room_state rs
         JOIN events e ON rs.event_id = e.event_id
         WHERE rs.room_id = ? AND rs.event_type = 'm.room.create'`,
      )
      .bind(roomId)
      .first<{ content: string }>(),
  ]);

  let roomType: string | undefined;
  if (createEvent) {
    try {
      roomType = JSON.parse(createEvent.content).type;
    } catch {}
  }

  let historyVisibility = "shared";
  if (historyEvent) {
    try {
      historyVisibility = JSON.parse(historyEvent.content).history_visibility;
    } catch {}
  }

  let guestAccess = false;
  if (guestEvent) {
    try {
      guestAccess = JSON.parse(guestEvent.content).guest_access === "can_join";
    } catch {}
  }

  return {
    room_id: roomId,
    name: nameEvent ? JSON.parse(nameEvent.content).name : undefined,
    topic: topicEvent ? JSON.parse(topicEvent.content).topic : undefined,
    canonical_alias: aliasEvent ? JSON.parse(aliasEvent.content).alias : undefined,
    avatar_url: avatarEvent ? JSON.parse(avatarEvent.content).url : undefined,
    join_rule: joinRuleEvent ? JSON.parse(joinRuleEvent.content).join_rule : "invite",
    num_joined_members: memberCount?.count || 0,
    world_readable: historyVisibility === "world_readable",
    guest_can_join: guestAccess,
    room_type: roomType,
  };
}

app.get("/_matrix/federation/v1/publicRooms", async (c) => {
  const limit = Math.min(Number.parseInt(c.req.query("limit") || "100", 10), 500);
  const since = c.req.query("since");
  void c.req.query("include_all_networks");

  let offset = 0;
  if (since && since.startsWith("offset_")) {
    offset = Number.parseInt(since.substring(7), 10) || 0;
  }

  const rooms = await c.env.DB.prepare(
    `SELECT r.room_id
     FROM rooms r
     WHERE r.is_public = 1
     ORDER BY r.created_at DESC
     LIMIT ? OFFSET ?`,
  )
    .bind(limit + 1, offset)
    .all<{ room_id: string }>();

  const hasMore = rooms.results.length > limit;
  const chunks = await Promise.all(
    rooms.results.slice(0, limit).map((room) => getRoomPublicInfo(c.env.DB, room.room_id)),
  );
  const totalCount = await c.env.DB.prepare(
    `SELECT COUNT(*) as count FROM rooms WHERE is_public = 1`,
  ).first<{ count: number }>();

  const response: any = {
    chunk: chunks.filter(Boolean),
    total_room_count_estimate: totalCount?.count || 0,
  };
  if (hasMore) {
    response.next_batch = `offset_${offset + limit}`;
  }
  if (offset > 0) {
    response.prev_batch = `offset_${Math.max(0, offset - limit)}`;
  }

  return c.json(response);
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

  const limit = Math.min(body.limit || 100, 500);
  const since = body.since;
  const searchTerm = body.filter?.generic_search_term?.toLowerCase();

  let offset = 0;
  if (since && since.startsWith("offset_")) {
    offset = Number.parseInt(since.substring(7), 10) || 0;
  }

  const rooms = searchTerm
    ? await c.env.DB.prepare(
        `SELECT DISTINCT r.room_id
         FROM rooms r
         LEFT JOIN room_state rs_name ON rs_name.room_id = r.room_id AND rs_name.event_type = 'm.room.name'
         LEFT JOIN events e_name ON rs_name.event_id = e_name.event_id
         LEFT JOIN room_state rs_topic ON rs_topic.room_id = r.room_id AND rs_topic.event_type = 'm.room.topic'
         LEFT JOIN events e_topic ON rs_topic.event_id = e_topic.event_id
         LEFT JOIN room_aliases ra ON ra.room_id = r.room_id
         WHERE r.is_public = 1
           AND (
             LOWER(e_name.content) LIKE ?
             OR LOWER(e_topic.content) LIKE ?
             OR LOWER(ra.alias) LIKE ?
           )
         ORDER BY r.created_at DESC
         LIMIT ? OFFSET ?`,
      )
        .bind(`%${searchTerm}%`, `%${searchTerm}%`, `%${searchTerm}%`, limit + 1, offset)
        .all<{ room_id: string }>()
    : await c.env.DB.prepare(
        `SELECT r.room_id
         FROM rooms r
         WHERE r.is_public = 1
         ORDER BY r.created_at DESC
         LIMIT ? OFFSET ?`,
      )
        .bind(limit + 1, offset)
        .all<{ room_id: string }>();

  const hasMore = rooms.results.length > limit;
  const chunks = await Promise.all(
    rooms.results.slice(0, limit).map((room) => getRoomPublicInfo(c.env.DB, room.room_id)),
  );
  const totalCount = await c.env.DB.prepare(
    `SELECT COUNT(*) as count FROM rooms WHERE is_public = 1`,
  ).first<{ count: number }>();

  const response: any = {
    chunk: chunks.filter(Boolean),
    total_room_count_estimate: totalCount?.count || 0,
  };
  if (hasMore) {
    response.next_batch = `offset_${offset + limit}`;
  }
  if (offset > 0) {
    response.prev_batch = `offset_${Math.max(0, offset - limit)}`;
  }

  return c.json(response);
});

app.get("/_matrix/federation/v1/openid/userinfo", async (c) => {
  const accessToken = c.req.query("access_token");
  if (!accessToken) {
    return Errors.missingParam("access_token").toResponse();
  }

  const tokenData = (await c.env.SESSIONS.get(`openid:${accessToken}`, "json")) as {
    user_id: string;
    expires_at: number;
  } | null;
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
