// Matrix Server-Server (Federation) API endpoints

import { Hono } from "hono";
import { Effect } from "effect";
import type { AppEnv, PDU } from "../types";
import { Errors, MatrixApiError } from "../utils/errors";
import { generateSigningKeyPair, signJson, sha256, verifySignature } from "../utils/crypto";
import { requireFederationAuth } from "../middleware/federation-auth";
import {
  getRemoteKeysWithNotarySignature,
  type ServerKeyResponse,
} from "../services/federation-keys";
import { validateUrl } from "../utils/url-validator";
import { storeEvent, fanoutEventToFederation, notifyUsersOfEvent } from "../services/database";
import { checkEventAuth } from "../services/event-auth";
import {
  applyMembershipTransitionToDatabase,
  loadMembershipTransitionContext,
} from "../matrix/application/membership-transition-service";
import { DomainError, toMatrixApiError } from "../matrix/application/domain-error";
import {
  ensureFederatedRoomStub,
  getMissingFederationEvents,
  loadFederationStateBundle,
  persistFederationMembershipEvent,
  persistInviteStrippedState,
} from "../matrix/application/federation-handler-service";
import {
  type FederationThirdPartyInviteValidationResult,
  validateInviteRequest,
  validateSendJoinRequest,
  validateSendKnockRequest,
  validateSendLeaveRequest,
  validateThirdPartyInviteExchangeRequest,
} from "../matrix/application/federation-validation";
import federationQueryRoutes from "./federation/query";
import federationSpaceRoutes from "./federation/spaces";

const app = new Hono<AppEnv>();

// GET /_matrix/federation/v1/version - Server version info (unauthenticated)
// This must be defined BEFORE the auth middleware is applied
app.get("/_matrix/federation/v1/version", async (c) => {
  return c.json({
    server: {
      name: "matrix-worker",
      version: c.env.SERVER_VERSION || "0.1.0",
    },
  });
});

// Apply federation authentication to all other federation v1 endpoints
// Key endpoints (/_matrix/key/*) remain unauthenticated as they are used to establish trust
// Version endpoint is also unauthenticated as it's used for initial contact
app.use("/_matrix/federation/v1/*", requireFederationAuth());
app.route("/", federationQueryRoutes);
app.route("/", federationSpaceRoutes);

async function runDomainValidation<A>(effect: Effect.Effect<A, DomainError>): Promise<A> {
  return Effect.runPromise(effect);
}

function toFederationErrorResponse(error: unknown): Response | null {
  if (error instanceof DomainError) {
    return toMatrixApiError(error).toResponse();
  }
  if (error instanceof MatrixApiError) {
    return error.toResponse();
  }
  return null;
}

// GET /_matrix/key/v2/server - Get server signing keys
app.get("/_matrix/key/v2/server", async (c) => {
  const serverName = c.env.SERVER_NAME;

  // Get or create server signing keys (prefer v2 keys with proper Ed25519)
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

  // Check if we need to generate a new secure key
  const hasSecureKey = keys.results.some((k) => k.key_version === 2 && k.private_key_jwk);

  if (keys.results.length === 0 || !hasSecureKey) {
    // Generate new secure signing key with proper Ed25519
    const keyPair = await generateSigningKeyPair();
    const validFrom = Date.now();
    const validUntil = validFrom + 365 * 24 * 60 * 60 * 1000; // 1 year

    // Mark old keys as not current
    await c.env.DB.prepare(`UPDATE server_keys SET is_current = 0`).run();

    // Insert new secure key
    await c.env.DB.prepare(
      `INSERT INTO server_keys (key_id, public_key, private_key, private_key_jwk, key_version, valid_from, valid_until, is_current)
       VALUES (?, ?, ?, ?, 2, ?, ?, 1)`,
    )
      .bind(
        keyPair.keyId,
        keyPair.publicKey,
        JSON.stringify(keyPair.privateKeyJwk), // Store JWK as string in legacy column too
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
    verifyKeys[key.key_id] = { key: key.public_key };
  }

  const validUntilTs = keys.results[0]?.valid_until || Date.now() + 365 * 24 * 60 * 60 * 1000;

  const response = {
    server_name: serverName,
    valid_until_ts: validUntilTs,
    verify_keys: verifyKeys,
    old_verify_keys: {},
  };

  // Sign the response with the secure key
  const currentKey = keys.results.find((k) => k.key_version === 2 && k.private_key_jwk);
  if (currentKey && currentKey.private_key_jwk) {
    const signed = await signJson(
      response,
      serverName,
      currentKey.key_id,
      JSON.parse(currentKey.private_key_jwk),
    );
    return c.json(signed);
  }

  return c.json(response);
});

// GET /_matrix/key/v2/server/:keyId - Get specific key
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

  const response = {
    server_name: serverName,
    valid_until_ts: key.valid_until || Date.now() + 365 * 24 * 60 * 60 * 1000,
    verify_keys: {
      [key.key_id]: { key: key.public_key },
    },
    old_verify_keys: {},
  };

  return c.json(response);
});

// Helper function to get our server's notary signing key
async function getNotarySigningKey(db: D1Database): Promise<{
  keyId: string;
  privateKeyJwk: JsonWebKey;
} | null> {
  const key = await db
    .prepare(
      `SELECT key_id, private_key_jwk FROM server_keys WHERE is_current = 1 AND key_version = 2`,
    )
    .first<{ key_id: string; private_key_jwk: string | null }>();

  if (!key || !key.private_key_jwk) {
    return null;
  }

  return {
    keyId: key.key_id,
    privateKeyJwk: JSON.parse(key.private_key_jwk),
  };
}

// Helper function to validate server name
function isValidServerName(serverName: string): boolean {
  // Basic server name validation
  // Server names should be hostname:port or just hostname
  // Must not contain SSRF-vulnerable patterns

  // Check for empty or too long
  if (!serverName || serverName.length > 255) {
    return false;
  }

  // Check using URL validation (construct a fake URL to validate the hostname)
  const testUrl = `https://${serverName}/`;
  const validation = validateUrl(testUrl);

  return validation.valid;
}

// Maximum number of servers in a batch query
const MAX_BATCH_SERVERS = 100;

// POST /_matrix/key/v2/query - Batch query for server keys (notary endpoint)
app.post("/_matrix/key/v2/query", async (c) => {
  let body: {
    server_keys?: Record<string, Record<string, { minimum_valid_until_ts?: number }>>;
  };

  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  const serverKeys = body.server_keys;
  if (!serverKeys || typeof serverKeys !== "object") {
    return Errors.missingParam("server_keys").toResponse();
  }

  // Check batch size limit
  const serverCount = Object.keys(serverKeys).length;
  if (serverCount > MAX_BATCH_SERVERS) {
    return c.json(
      {
        errcode: "M_LIMIT_EXCEEDED",
        error: `Too many servers in batch request (max ${MAX_BATCH_SERVERS})`,
      },
      400,
    );
  }

  // Get our notary signing key
  const notaryKey = await getNotarySigningKey(c.env.DB);
  if (!notaryKey) {
    return c.json(
      {
        errcode: "M_UNKNOWN",
        error: "Server signing key not configured",
      },
      500,
    );
  }

  const results: ServerKeyResponse[] = [];

  // Process each server in the request
  for (const [serverName, keyRequests] of Object.entries(serverKeys)) {
    // Validate server name to prevent SSRF
    if (!isValidServerName(serverName)) {
      console.warn(`Invalid server name in key query: ${serverName}`);
      continue;
    }

    // If querying our own server, return our keys directly
    if (serverName === c.env.SERVER_NAME) {
      const ownKeys = await c.env.DB.prepare(
        `SELECT key_id, public_key, valid_until FROM server_keys WHERE is_current = 1`,
      ).all<{ key_id: string; public_key: string; valid_until: number | null }>();

      if (ownKeys.results.length > 0) {
        const verifyKeys: Record<string, { key: string }> = {};
        let maxValidUntil = 0;

        for (const key of ownKeys.results) {
          verifyKeys[key.key_id] = { key: key.public_key };
          if (key.valid_until && key.valid_until > maxValidUntil) {
            maxValidUntil = key.valid_until;
          }
        }

        const ownResponse: ServerKeyResponse = {
          server_name: serverName,
          valid_until_ts: maxValidUntil || Date.now() + 365 * 24 * 60 * 60 * 1000,
          verify_keys: verifyKeys,
          old_verify_keys: {},
        };

        // Sign with our own key
        const signed = (await signJson(
          ownResponse,
          c.env.SERVER_NAME,
          notaryKey.keyId,
          notaryKey.privateKeyJwk,
        )) as ServerKeyResponse;

        results.push(signed);
      }
      continue;
    }

    // Process each key request for this server
    for (const [keyId, keyRequest] of Object.entries(keyRequests)) {
      const minimumValidUntilTs = keyRequest.minimum_valid_until_ts || 0;

      // Fetch keys with notary signature
      const keyResponses = await getRemoteKeysWithNotarySignature(
        serverName,
        keyId === "" ? null : keyId, // Empty key ID means all keys
        minimumValidUntilTs,
        c.env.DB,
        c.env.CACHE,
        c.env.SERVER_NAME,
        notaryKey.keyId,
        notaryKey.privateKeyJwk,
      );

      results.push(...keyResponses);
    }
  }

  return c.json({ server_keys: results });
});

// GET /_matrix/key/v2/query/:serverName - Query all keys for a server
app.get("/_matrix/key/v2/query/:serverName", async (c) => {
  const serverName = c.req.param("serverName");
  const minimumValidUntilTs = parseInt(c.req.query("minimum_valid_until_ts") || "0", 10);

  // Validate server name to prevent SSRF
  if (!isValidServerName(serverName)) {
    return c.json(
      {
        errcode: "M_INVALID_PARAM",
        error: "Invalid server name",
      },
      400,
    );
  }

  // Get our notary signing key
  const notaryKey = await getNotarySigningKey(c.env.DB);
  if (!notaryKey) {
    return c.json(
      {
        errcode: "M_UNKNOWN",
        error: "Server signing key not configured",
      },
      500,
    );
  }

  // If querying our own server, return our keys directly
  if (serverName === c.env.SERVER_NAME) {
    const ownKeys = await c.env.DB.prepare(
      `SELECT key_id, public_key, valid_until FROM server_keys WHERE is_current = 1`,
    ).all<{ key_id: string; public_key: string; valid_until: number | null }>();

    if (ownKeys.results.length === 0) {
      return Errors.notFound("No keys found").toResponse();
    }

    const verifyKeys: Record<string, { key: string }> = {};
    let maxValidUntil = 0;

    for (const key of ownKeys.results) {
      verifyKeys[key.key_id] = { key: key.public_key };
      if (key.valid_until && key.valid_until > maxValidUntil) {
        maxValidUntil = key.valid_until;
      }
    }

    const ownResponse: ServerKeyResponse = {
      server_name: serverName,
      valid_until_ts: maxValidUntil || Date.now() + 365 * 24 * 60 * 60 * 1000,
      verify_keys: verifyKeys,
      old_verify_keys: {},
    };

    // Sign with our own key
    const signed = (await signJson(
      ownResponse,
      c.env.SERVER_NAME,
      notaryKey.keyId,
      notaryKey.privateKeyJwk,
    )) as ServerKeyResponse;

    return c.json({ server_keys: [signed] });
  }

  // Fetch keys from remote server with notary signature
  const keyResponses = await getRemoteKeysWithNotarySignature(
    serverName,
    null, // All keys
    minimumValidUntilTs,
    c.env.DB,
    c.env.CACHE,
    c.env.SERVER_NAME,
    notaryKey.keyId,
    notaryKey.privateKeyJwk,
  );

  if (keyResponses.length === 0) {
    return Errors.notFound("No keys found for server").toResponse();
  }

  return c.json({ server_keys: keyResponses });
});

// GET /_matrix/key/v2/query/:serverName/:keyId - Query specific key for a server
app.get("/_matrix/key/v2/query/:serverName/:keyId", async (c) => {
  const serverName = c.req.param("serverName");
  const keyId = c.req.param("keyId");
  const minimumValidUntilTs = parseInt(c.req.query("minimum_valid_until_ts") || "0", 10);

  // Validate server name to prevent SSRF
  if (!isValidServerName(serverName)) {
    return c.json(
      {
        errcode: "M_INVALID_PARAM",
        error: "Invalid server name",
      },
      400,
    );
  }

  // Get our notary signing key
  const notaryKey = await getNotarySigningKey(c.env.DB);
  if (!notaryKey) {
    return c.json(
      {
        errcode: "M_UNKNOWN",
        error: "Server signing key not configured",
      },
      500,
    );
  }

  // If querying our own server, return the specific key
  if (serverName === c.env.SERVER_NAME) {
    const ownKey = await c.env.DB.prepare(
      `SELECT key_id, public_key, valid_until FROM server_keys WHERE key_id = ?`,
    )
      .bind(keyId)
      .first<{ key_id: string; public_key: string; valid_until: number | null }>();

    if (!ownKey) {
      return Errors.notFound("Key not found").toResponse();
    }

    const ownResponse: ServerKeyResponse = {
      server_name: serverName,
      valid_until_ts: ownKey.valid_until || Date.now() + 365 * 24 * 60 * 60 * 1000,
      verify_keys: {
        [ownKey.key_id]: { key: ownKey.public_key },
      },
      old_verify_keys: {},
    };

    // Sign with our own key
    const signed = (await signJson(
      ownResponse,
      c.env.SERVER_NAME,
      notaryKey.keyId,
      notaryKey.privateKeyJwk,
    )) as ServerKeyResponse;

    return c.json({ server_keys: [signed] });
  }

  // Fetch specific key from remote server with notary signature
  const keyResponses = await getRemoteKeysWithNotarySignature(
    serverName,
    keyId,
    minimumValidUntilTs,
    c.env.DB,
    c.env.CACHE,
    c.env.SERVER_NAME,
    notaryKey.keyId,
    notaryKey.privateKeyJwk,
  );

  if (keyResponses.length === 0) {
    return Errors.notFound("Key not found").toResponse();
  }

  return c.json({ server_keys: keyResponses });
});

// PUT /_matrix/federation/v1/send/:txnId - Receive events from remote server
// This endpoint is now protected by requireFederationAuth middleware
app.put("/_matrix/federation/v1/send/:txnId", async (c) => {
  const txnId = c.req.param("txnId");

  // Origin is now authenticated via the federation auth middleware
  const origin = c.get("federationOrigin" as any) as string | undefined;
  if (!origin) {
    return Errors.unauthorized("Federation authentication required").toResponse();
  }

  try {
    const body = await c.req.json();
    const response = await c.get("appContext").services.federation.processTransaction({
      origin,
      txnId,
      body,
    });
    return c.json(response);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return Errors.badJson().toResponse();
    }
    if (error instanceof Error && "toResponse" in error) {
      return (error as { toResponse(): Response }).toResponse();
    }
    throw error;
  }
});

// GET /_matrix/federation/v1/event/:eventId - Get a single event
app.get("/_matrix/federation/v1/event/:eventId", async (c) => {
  const eventId = c.req.param("eventId");

  const event = await c.env.DB.prepare(
    `SELECT event_id, room_id, sender, event_type, state_key, content,
     origin_server_ts, depth, auth_events, prev_events, hashes, signatures
     FROM events WHERE event_id = ?`,
  )
    .bind(eventId)
    .first<{
      event_id: string;
      room_id: string;
      sender: string;
      event_type: string;
      state_key: string | null;
      content: string;
      origin_server_ts: number;
      depth: number;
      auth_events: string;
      prev_events: string;
      hashes: string | null;
      signatures: string | null;
    }>();

  if (!event) {
    return Errors.notFound("Event not found").toResponse();
  }

  const pdu: PDU = {
    event_id: event.event_id,
    room_id: event.room_id,
    sender: event.sender,
    type: event.event_type,
    state_key: event.state_key ?? undefined,
    content: JSON.parse(event.content),
    origin_server_ts: event.origin_server_ts,
    depth: event.depth,
    auth_events: JSON.parse(event.auth_events),
    prev_events: JSON.parse(event.prev_events),
    hashes: event.hashes ? JSON.parse(event.hashes) : undefined,
    signatures: event.signatures ? JSON.parse(event.signatures) : undefined,
  };

  return c.json({
    origin: c.env.SERVER_NAME,
    origin_server_ts: Date.now(),
    pdus: [pdu],
  });
});

// GET /_matrix/federation/v1/state/:roomId - Get room state
app.get("/_matrix/federation/v1/state/:roomId", async (c) => {
  const roomId = c.req.param("roomId");
  // Note: eventId could be used to get state at a specific point in time
  void c.req.query("event_id");

  // Get current room state
  const stateEvents = await c.env.DB.prepare(
    `SELECT e.event_id, e.room_id, e.sender, e.event_type, e.state_key, e.content,
     e.origin_server_ts, e.depth, e.auth_events, e.prev_events
     FROM room_state rs
     JOIN events e ON rs.event_id = e.event_id
     WHERE rs.room_id = ?`,
  )
    .bind(roomId)
    .all<{
      event_id: string;
      room_id: string;
      sender: string;
      event_type: string;
      state_key: string | null;
      content: string;
      origin_server_ts: number;
      depth: number;
      auth_events: string;
      prev_events: string;
    }>();

  const pdus = stateEvents.results.map((e) => ({
    event_id: e.event_id,
    room_id: e.room_id,
    sender: e.sender,
    type: e.event_type,
    state_key: e.state_key ?? "",
    content: JSON.parse(e.content),
    origin_server_ts: e.origin_server_ts,
    depth: e.depth,
    auth_events: JSON.parse(e.auth_events),
    prev_events: JSON.parse(e.prev_events),
  }));

  // Get auth chain
  const authEventIds = new Set<string>();
  for (const pdu of pdus) {
    for (const authId of pdu.auth_events) {
      authEventIds.add(authId);
    }
  }

  const authChain: any[] = [];
  for (const authId of authEventIds) {
    const authEvent = await c.env.DB.prepare(
      `SELECT event_id, room_id, sender, event_type, state_key, content,
       origin_server_ts, depth, auth_events, prev_events
       FROM events WHERE event_id = ?`,
    )
      .bind(authId)
      .first();

    if (authEvent) {
      authChain.push({
        ...authEvent,
        type: (authEvent as any).event_type,
        content: JSON.parse((authEvent as any).content),
        auth_events: JSON.parse((authEvent as any).auth_events),
        prev_events: JSON.parse((authEvent as any).prev_events),
      });
    }
  }

  return c.json({
    origin: c.env.SERVER_NAME,
    origin_server_ts: Date.now(),
    pdus,
    auth_chain: authChain,
  });
});

// GET /_matrix/federation/v1/state_ids/:roomId - Get room state event IDs only
app.get("/_matrix/federation/v1/state_ids/:roomId", async (c) => {
  const roomId = c.req.param("roomId");
  const eventId = c.req.query("event_id");

  // Verify room exists
  const room = await c.env.DB.prepare(`SELECT room_id FROM rooms WHERE room_id = ?`)
    .bind(roomId)
    .first<{ room_id: string }>();

  if (!room) {
    return Errors.notFound("Room not found").toResponse();
  }

  // Get state event IDs
  let stateEventIds: string[];
  let authChainIds: string[];

  if (eventId) {
    // Get state at a specific event
    // For now, we get current state - proper implementation would track state snapshots
    const stateEvents = await c.env.DB.prepare(
      `SELECT e.event_id, e.auth_events
       FROM room_state rs
       JOIN events e ON rs.event_id = e.event_id
       WHERE rs.room_id = ?`,
    )
      .bind(roomId)
      .all<{ event_id: string; auth_events: string }>();

    stateEventIds = stateEvents.results.map((e) => e.event_id);

    // Collect auth chain IDs
    const authChainSet = new Set<string>();
    for (const event of stateEvents.results) {
      const authEvents = JSON.parse(event.auth_events) as string[];
      for (const authId of authEvents) {
        authChainSet.add(authId);
      }
    }
    authChainIds = Array.from(authChainSet);
  } else {
    // Get current state
    const stateEvents = await c.env.DB.prepare(
      `SELECT e.event_id, e.auth_events
       FROM room_state rs
       JOIN events e ON rs.event_id = e.event_id
       WHERE rs.room_id = ?`,
    )
      .bind(roomId)
      .all<{ event_id: string; auth_events: string }>();

    stateEventIds = stateEvents.results.map((e) => e.event_id);

    // Collect auth chain IDs
    const authChainSet = new Set<string>();
    for (const event of stateEvents.results) {
      const authEvents = JSON.parse(event.auth_events) as string[];
      for (const authId of authEvents) {
        authChainSet.add(authId);
      }
    }
    authChainIds = Array.from(authChainSet);
  }

  return c.json({
    pdu_ids: stateEventIds,
    auth_chain_ids: authChainIds,
  });
});

// GET /_matrix/federation/v1/event_auth/:roomId/:eventId - Get auth chain for an event
app.get("/_matrix/federation/v1/event_auth/:roomId/:eventId", async (c) => {
  const roomId = c.req.param("roomId");
  const eventId = c.req.param("eventId");

  // Verify room exists
  const room = await c.env.DB.prepare(`SELECT room_id FROM rooms WHERE room_id = ?`)
    .bind(roomId)
    .first<{ room_id: string }>();

  if (!room) {
    return Errors.notFound("Room not found").toResponse();
  }

  // Get the event
  const event = await c.env.DB.prepare(
    `SELECT event_id, auth_events FROM events WHERE event_id = ? AND room_id = ?`,
  )
    .bind(eventId, roomId)
    .first<{ event_id: string; auth_events: string }>();

  if (!event) {
    return Errors.notFound("Event not found").toResponse();
  }

  // Build auth chain by recursively collecting auth events
  const authChain: PDU[] = [];
  const visited = new Set<string>();
  const toProcess = JSON.parse(event.auth_events) as string[];

  while (toProcess.length > 0) {
    const authId = toProcess.shift()!;
    if (visited.has(authId)) continue;
    visited.add(authId);

    const authEvent = await c.env.DB.prepare(
      `SELECT event_id, room_id, sender, event_type, state_key, content,
       origin_server_ts, depth, auth_events, prev_events, hashes, signatures
       FROM events WHERE event_id = ?`,
    )
      .bind(authId)
      .first<{
        event_id: string;
        room_id: string;
        sender: string;
        event_type: string;
        state_key: string | null;
        content: string;
        origin_server_ts: number;
        depth: number;
        auth_events: string;
        prev_events: string;
        hashes: string | null;
        signatures: string | null;
      }>();

    if (authEvent) {
      authChain.push({
        event_id: authEvent.event_id,
        room_id: authEvent.room_id,
        sender: authEvent.sender,
        type: authEvent.event_type,
        state_key: authEvent.state_key ?? undefined,
        content: JSON.parse(authEvent.content),
        origin_server_ts: authEvent.origin_server_ts,
        depth: authEvent.depth,
        auth_events: JSON.parse(authEvent.auth_events),
        prev_events: JSON.parse(authEvent.prev_events),
        hashes: authEvent.hashes ? JSON.parse(authEvent.hashes) : undefined,
        signatures: authEvent.signatures ? JSON.parse(authEvent.signatures) : undefined,
      });

      // Add this event's auth_events to process
      const moreAuthEvents = JSON.parse(authEvent.auth_events) as string[];
      for (const id of moreAuthEvents) {
        if (!visited.has(id)) {
          toProcess.push(id);
        }
      }
    }
  }

  return c.json({
    auth_chain: authChain,
  });
});

// GET /_matrix/federation/v1/backfill/:roomId - Fetch historical events
app.get("/_matrix/federation/v1/backfill/:roomId", async (c) => {
  const roomId = c.req.param("roomId");
  const limit = Math.min(parseInt(c.req.query("limit") || "100", 10), 1000);
  const vParam = c.req.query("v"); // Starting event IDs

  // Verify room exists
  const room = await c.env.DB.prepare(`SELECT room_id FROM rooms WHERE room_id = ?`)
    .bind(roomId)
    .first<{ room_id: string }>();

  if (!room) {
    return Errors.notFound("Room not found").toResponse();
  }

  // Parse starting event IDs
  const startEventIds = vParam ? vParam.split(",") : [];

  let events: any[];
  if (startEventIds.length > 0) {
    // Get events before the specified events
    const startEvents = await c.env.DB.prepare(
      `SELECT MIN(depth) as min_depth FROM events WHERE event_id IN (${startEventIds.map(() => "?").join(",")})`,
    )
      .bind(...startEventIds)
      .first<{ min_depth: number }>();

    const maxDepth = startEvents?.min_depth || 0;

    events = (
      await c.env.DB.prepare(
        `SELECT event_id, room_id, sender, event_type, state_key, content,
       origin_server_ts, depth, auth_events, prev_events, hashes, signatures
       FROM events
       WHERE room_id = ? AND depth < ?
       ORDER BY depth DESC
       LIMIT ?`,
      )
        .bind(roomId, maxDepth, limit)
        .all()
    ).results;
  } else {
    // Get most recent events
    events = (
      await c.env.DB.prepare(
        `SELECT event_id, room_id, sender, event_type, state_key, content,
       origin_server_ts, depth, auth_events, prev_events, hashes, signatures
       FROM events
       WHERE room_id = ?
       ORDER BY depth DESC
       LIMIT ?`,
      )
        .bind(roomId, limit)
        .all()
    ).results;
  }

  const pdus = events.map((e: any) => ({
    event_id: e.event_id,
    room_id: e.room_id,
    sender: e.sender,
    type: e.event_type,
    state_key: e.state_key ?? undefined,
    content: JSON.parse(e.content),
    origin_server_ts: e.origin_server_ts,
    depth: e.depth,
    auth_events: JSON.parse(e.auth_events),
    prev_events: JSON.parse(e.prev_events),
    hashes: e.hashes ? JSON.parse(e.hashes) : undefined,
    signatures: e.signatures ? JSON.parse(e.signatures) : undefined,
  }));

  return c.json({
    origin: c.env.SERVER_NAME,
    origin_server_ts: Date.now(),
    pdus,
  });
});

// POST /_matrix/federation/v1/get_missing_events/:roomId - Retrieve missing events between DAG tips
app.post("/_matrix/federation/v1/get_missing_events/:roomId", async (c) => {
  const roomId = c.req.param("roomId");

  let body: {
    earliest_events?: string[];
    latest_events?: string[];
    limit?: number;
    min_depth?: number;
  };
  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  const room = await c.env.DB.prepare(`SELECT room_id FROM rooms WHERE room_id = ?`)
    .bind(roomId)
    .first<{ room_id: string }>();
  if (!room) {
    return Errors.notFound("Room not found").toResponse();
  }

  const earliestEvents = Array.isArray(body.earliest_events) ? body.earliest_events : [];
  const latestEvents = Array.isArray(body.latest_events) ? body.latest_events : [];
  const limit = Math.min(Math.max(body.limit ?? 10, 1), 100);
  const minDepth = Math.max(body.min_depth ?? 0, 0);

  const events = await getMissingFederationEvents(c.env.DB, {
    roomId,
    earliestEvents,
    latestEvents,
    limit,
    minDepth,
  });

  return c.json({ events });
});

// POST /_matrix/federation/v1/make_join/:roomId/:userId - Prepare join request
app.get("/_matrix/federation/v1/make_join/:roomId/:userId", async (c) => {
  const roomId = c.req.param("roomId");
  const userId = c.req.param("userId");

  // Check if room exists and is joinable
  const room = await c.env.DB.prepare(`SELECT room_id, room_version FROM rooms WHERE room_id = ?`)
    .bind(roomId)
    .first<{ room_id: string; room_version: string }>();

  if (!room) {
    return Errors.notFound("Room not found").toResponse();
  }

  // Get current room state for auth events
  const createEvent = await c.env.DB.prepare(
    `SELECT e.event_id FROM room_state rs
     JOIN events e ON rs.event_id = e.event_id
     WHERE rs.room_id = ? AND rs.event_type = 'm.room.create'`,
  )
    .bind(roomId)
    .first<{ event_id: string }>();

  const joinRulesEvent = await c.env.DB.prepare(
    `SELECT e.event_id FROM room_state rs
     JOIN events e ON rs.event_id = e.event_id
     WHERE rs.room_id = ? AND rs.event_type = 'm.room.join_rules'`,
  )
    .bind(roomId)
    .first<{ event_id: string }>();

  const powerLevelsEvent = await c.env.DB.prepare(
    `SELECT e.event_id FROM room_state rs
     JOIN events e ON rs.event_id = e.event_id
     WHERE rs.room_id = ? AND rs.event_type = 'm.room.power_levels'`,
  )
    .bind(roomId)
    .first<{ event_id: string }>();

  const currentMembership = await c.env.DB.prepare(
    `SELECT membership, event_id FROM room_memberships WHERE room_id = ? AND user_id = ?`,
  )
    .bind(roomId, userId)
    .first<{ membership: string; event_id: string }>();

  if (currentMembership?.membership === "ban") {
    return c.json({ errcode: "M_FORBIDDEN", error: "User is banned from this room" }, 403);
  }

  if (joinRulesEvent) {
    const joinRulesRow = await c.env.DB.prepare(
      `SELECT e.content FROM room_state rs
       JOIN events e ON rs.event_id = e.event_id
       WHERE rs.room_id = ? AND rs.event_type = 'm.room.join_rules'`,
    )
      .bind(roomId)
      .first<{ content: string }>();
    const joinRule = joinRulesRow
      ? (JSON.parse(joinRulesRow.content) as { join_rule?: string }).join_rule || "invite"
      : "invite";

    if (
      (joinRule === "knock" || joinRule === "knock_restricted") &&
      currentMembership?.membership !== "invite" &&
      currentMembership?.membership !== "join"
    ) {
      return c.json({ errcode: "M_FORBIDDEN", error: "Cannot join room without an invite" }, 403);
    }
  }

  const authEvents: string[] = [];
  if (createEvent) authEvents.push(createEvent.event_id);
  if (joinRulesEvent) authEvents.push(joinRulesEvent.event_id);
  if (powerLevelsEvent) authEvents.push(powerLevelsEvent.event_id);
  if (currentMembership?.event_id) authEvents.push(currentMembership.event_id);

  // Get latest event for prev_events
  const latestEvent = await c.env.DB.prepare(
    `SELECT event_id, depth FROM events WHERE room_id = ? ORDER BY depth DESC LIMIT 1`,
  )
    .bind(roomId)
    .first<{ event_id: string; depth: number }>();

  const prevEvents = latestEvent ? [latestEvent.event_id] : [];
  const depth = (latestEvent?.depth || 0) + 1;

  // Create unsigned join event template
  const eventTemplate = {
    room_id: roomId,
    sender: userId,
    type: "m.room.member",
    state_key: userId,
    content: {
      membership: "join",
    },
    origin_server_ts: Date.now(),
    depth,
    auth_events: authEvents,
    prev_events: prevEvents,
  };

  return c.json({
    room_version: room.room_version,
    event: eventTemplate,
  });
});

async function handleSendJoin(c: any, version: "v1" | "v2"): Promise<Response> {
  const roomId = c.req.param("roomId");
  const eventId = c.req.param("eventId");

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  try {
    const validated = await runDomainValidation(
      validateSendJoinRequest({
        body,
        roomId,
        eventId,
      }),
    );

    const room = (await c.env.DB.prepare(
      `SELECT room_id, room_version FROM rooms WHERE room_id = ?`,
    )
      .bind(roomId)
      .first()) as { room_id: string; room_version: string } | null;
    if (!room) {
      return Errors.notFound("Room not found").toResponse();
    }

    const stateBundle = await loadFederationStateBundle(c.env.DB, roomId);
    const authResult = checkEventAuth(validated.event, stateBundle.roomState, room.room_version);
    if (!authResult.allowed) {
      return c.json(
        { errcode: "M_FORBIDDEN", error: authResult.error || "Join event not allowed" },
        403,
      );
    }

    await persistFederationMembershipEvent(c.env.DB, {
      roomId,
      event: validated.event,
      source: "federation",
    });

    c.executionCtx.waitUntil(fanoutEventToFederation(c.env, roomId, validated.event));

    if (version === "v1") {
      return c.json({
        origin: c.env.SERVER_NAME,
        auth_chain: stateBundle.authChain,
        state: stateBundle.state,
        event: validated.event,
      });
    }

    return c.json({
      origin: c.env.SERVER_NAME,
      auth_chain: stateBundle.authChain,
      state: stateBundle.state,
      event: validated.event,
      members_omitted: false,
      servers_in_room: stateBundle.serversInRoom,
    });
  } catch (error) {
    const response = toFederationErrorResponse(error);
    if (response) {
      return response;
    }
    throw error;
  }
}

// PUT /_matrix/federation/v1/send_join/:roomId/:eventId - Complete join
app.put("/_matrix/federation/v1/send_join/:roomId/:eventId", async (c) => {
  return handleSendJoin(c, "v1");
});

// PUT /_matrix/federation/v2/send_join/:roomId/:eventId - Complete join (v2)
// v2 wraps response in { event, state, auth_chain, ... } instead of returning array
app.put("/_matrix/federation/v2/send_join/:roomId/:eventId", async (c) => {
  return handleSendJoin(c, "v2");
});

// GET /_matrix/federation/v1/make_leave/:roomId/:userId - Prepare leave request
app.get("/_matrix/federation/v1/make_leave/:roomId/:userId", async (c) => {
  const roomId = c.req.param("roomId");
  const userId = c.req.param("userId");

  // Check if room exists
  const room = await c.env.DB.prepare(`SELECT room_id, room_version FROM rooms WHERE room_id = ?`)
    .bind(roomId)
    .first<{ room_id: string; room_version: string }>();

  if (!room) {
    return Errors.notFound("Room not found").toResponse();
  }

  const membership = await c.env.DB.prepare(
    `SELECT event_id, membership FROM room_memberships WHERE room_id = ? AND user_id = ?`,
  )
    .bind(roomId, userId)
    .first<{ event_id: string; membership: string }>();

  if (!membership || !["join", "invite", "knock"].includes(membership.membership)) {
    return c.json(
      { errcode: "M_FORBIDDEN", error: "User is not joined, invited, or knocking in the room" },
      403,
    );
  }

  // Get auth events for leave
  const createEvent = await c.env.DB.prepare(
    `SELECT e.event_id FROM room_state rs
     JOIN events e ON rs.event_id = e.event_id
     WHERE rs.room_id = ? AND rs.event_type = 'm.room.create'`,
  )
    .bind(roomId)
    .first<{ event_id: string }>();

  const powerLevelsEvent = await c.env.DB.prepare(
    `SELECT e.event_id FROM room_state rs
     JOIN events e ON rs.event_id = e.event_id
     WHERE rs.room_id = ? AND rs.event_type = 'm.room.power_levels'`,
  )
    .bind(roomId)
    .first<{ event_id: string }>();

  const authEvents: string[] = [];
  if (createEvent) authEvents.push(createEvent.event_id);
  if (powerLevelsEvent) authEvents.push(powerLevelsEvent.event_id);
  authEvents.push(membership.event_id);

  // Get latest event for prev_events
  const latestEvent = await c.env.DB.prepare(
    `SELECT event_id, depth FROM events WHERE room_id = ? ORDER BY depth DESC LIMIT 1`,
  )
    .bind(roomId)
    .first<{ event_id: string; depth: number }>();

  const prevEvents = latestEvent ? [latestEvent.event_id] : [];
  const depth = (latestEvent?.depth || 0) + 1;

  // Create unsigned leave event template
  const eventTemplate = {
    room_id: roomId,
    sender: userId,
    type: "m.room.member",
    state_key: userId,
    content: {
      membership: "leave",
    },
    origin_server_ts: Date.now(),
    depth,
    auth_events: authEvents,
    prev_events: prevEvents,
  };

  return c.json({
    room_version: room.room_version,
    event: eventTemplate,
  });
});

async function persistFederationLeave(
  c: any,
  roomId: string,
  fallbackEventId: string,
  body: any,
): Promise<PDU> {
  const leaveEventId = body.event_id || fallbackEventId;
  const leavePdu: PDU = {
    event_id: leaveEventId,
    room_id: roomId,
    sender: body.sender,
    type: body.type,
    state_key: body.state_key ?? undefined,
    content: body.content ?? {},
    origin_server_ts: body.origin_server_ts || Date.now(),
    unsigned: body.unsigned,
    depth: body.depth || 0,
    auth_events: body.auth_events || [],
    prev_events: body.prev_events || [],
    hashes: body.hashes,
    signatures: body.signatures,
  };

  const existing = await c.env.DB.prepare(`SELECT event_id FROM events WHERE event_id = ?`)
    .bind(leaveEventId)
    .first();
  const leaveTransitionContext = await loadMembershipTransitionContext(
    c.env.DB,
    roomId,
    leavePdu.state_key,
  );
  if (!existing) {
    await storeEvent(c.env.DB, leavePdu);
  }

  await applyMembershipTransitionToDatabase(c.env.DB, {
    roomId,
    event: leavePdu,
    source: "federation",
    context: leaveTransitionContext,
  });

  await notifyUsersOfEvent(c.env, roomId, leaveEventId, "m.room.member");
  c.executionCtx.waitUntil(fanoutEventToFederation(c.env, roomId, leavePdu));

  return leavePdu;
}

// PUT /_matrix/federation/v1/send_leave/:roomId/:eventId - Complete leave
app.put("/_matrix/federation/v1/send_leave/:roomId/:eventId", async (c) => {
  const roomId = c.req.param("roomId");
  const eventId = c.req.param("eventId");

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  try {
    await runDomainValidation(validateSendLeaveRequest({ body, roomId, eventId }));
  } catch (error) {
    const response = toFederationErrorResponse(error);
    if (response) {
      return response;
    }
    throw error;
  }

  // Verify room exists
  const room = await c.env.DB.prepare(`SELECT room_id FROM rooms WHERE room_id = ?`)
    .bind(roomId)
    .first<{ room_id: string }>();

  if (!room) {
    return Errors.notFound("Room not found").toResponse();
  }

  await persistFederationLeave(c, roomId, eventId, body);

  // v1 returns empty array on success [200, {}]
  return c.json([200, {}]);
});

// PUT /_matrix/federation/v2/send_leave/:roomId/:eventId - Complete leave (v2)
app.put("/_matrix/federation/v2/send_leave/:roomId/:eventId", async (c) => {
  const roomId = c.req.param("roomId");
  const eventId = c.req.param("eventId");

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  try {
    await runDomainValidation(validateSendLeaveRequest({ body, roomId, eventId }));
  } catch (error) {
    const response = toFederationErrorResponse(error);
    if (response) {
      return response;
    }
    throw error;
  }

  // Verify room exists
  const room = await c.env.DB.prepare(`SELECT room_id FROM rooms WHERE room_id = ?`)
    .bind(roomId)
    .first<{ room_id: string }>();

  if (!room) {
    return Errors.notFound("Room not found").toResponse();
  }

  await persistFederationLeave(c, roomId, eventId, body);

  // v2 returns empty object on success
  return c.json({});
});

async function handleFederationInvite(c: any, version: "v1" | "v2"): Promise<Response> {
  void c.req.param("roomId");
  const eventId = c.req.param("eventId");

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  try {
    const validated = await runDomainValidation(
      validateInviteRequest({
        body,
        eventId,
        serverName: c.env.SERVER_NAME,
        requireRoomVersion: version === "v2",
      }),
    );

    const localUser = (await c.env.DB.prepare(`SELECT user_id FROM users WHERE user_id = ?`)
      .bind(validated.invitedUserId)
      .first()) as { user_id: string } | null;
    if (!localUser) {
      return c.json({ errcode: "M_NOT_FOUND", error: "User not found" }, 404);
    }

    const key = (await c.env.DB.prepare(
      `SELECT key_id, private_key_jwk FROM server_keys WHERE is_current = 1 AND key_version = 2`,
    ).first()) as { key_id: string; private_key_jwk: string | null } | null;
    if (!key || !key.private_key_jwk) {
      return c.json({ errcode: "M_UNKNOWN", error: "Server signing key not configured" }, 500);
    }

    const signedEvent = (await signJson(
      validated.event as unknown as Record<string, unknown>,
      c.env.SERVER_NAME,
      key.key_id,
      JSON.parse(key.private_key_jwk),
    )) as Record<string, any>;

    await ensureFederatedRoomStub(
      c.env.DB,
      validated.roomId,
      validated.roomVersion,
      validated.event.sender,
    );

    const invitePdu: PDU = {
      ...validated.event,
      event_id: signedEvent.event_id || validated.event.event_id,
      room_id: validated.roomId,
      sender: signedEvent.sender || validated.event.sender,
      type: signedEvent.type || validated.event.type,
      state_key: signedEvent.state_key ?? validated.event.state_key,
      content: signedEvent.content || validated.event.content,
      origin_server_ts: signedEvent.origin_server_ts || validated.event.origin_server_ts,
      depth: signedEvent.depth || validated.event.depth,
      auth_events: signedEvent.auth_events || validated.event.auth_events,
      prev_events: signedEvent.prev_events || validated.event.prev_events,
      unsigned: signedEvent.unsigned || validated.event.unsigned,
      hashes: signedEvent.hashes as { sha256: string } | undefined,
      signatures: signedEvent.signatures as Record<string, Record<string, string>> | undefined,
    };

    await persistFederationMembershipEvent(c.env.DB, {
      roomId: validated.roomId,
      event: invitePdu,
      source: "federation",
    });
    await persistInviteStrippedState(c.env.DB, validated.roomId, validated.inviteRoomState);

    if (version === "v1") {
      return c.json([200, signedEvent]);
    }

    return c.json({ event: signedEvent });
  } catch (error) {
    const response = toFederationErrorResponse(error);
    if (response) {
      return response;
    }
    throw error;
  }
}

// PUT /_matrix/federation/v1/invite/:roomId/:eventId - Receive invite (v1)
// Used when a remote server invites a local user to a room
app.put("/_matrix/federation/v1/invite/:roomId/:eventId", async (c) => {
  return handleFederationInvite(c, "v1");
});

// PUT /_matrix/federation/v2/invite/:roomId/:eventId - Receive invite (v2)
app.put("/_matrix/federation/v2/invite/:roomId/:eventId", async (c) => {
  return handleFederationInvite(c, "v2");
});

// GET /_matrix/federation/v1/query/directory - Resolve room alias
app.get("/_matrix/federation/v1/query/directory", async (c) => {
  const alias = c.req.query("room_alias");

  if (!alias) {
    return Errors.missingParam("room_alias").toResponse();
  }

  const roomId = await c.env.DB.prepare(`SELECT room_id FROM room_aliases WHERE alias = ?`)
    .bind(alias)
    .first<{ room_id: string }>();

  if (!roomId) {
    return Errors.notFound("Room alias not found").toResponse();
  }

  return c.json({
    room_id: roomId.room_id,
    servers: [c.env.SERVER_NAME],
  });
});

// GET /_matrix/federation/v1/query/profile - Query user profile
app.get("/_matrix/federation/v1/query/profile", async (c) => {
  const userId = c.req.query("user_id");
  const field = c.req.query("field");

  if (!userId) {
    return Errors.missingParam("user_id").toResponse();
  }

  const user = await c.env.DB.prepare(
    `SELECT display_name, avatar_url FROM users WHERE user_id = ?`,
  )
    .bind(userId)
    .first<{ display_name: string | null; avatar_url: string | null }>();

  if (!user) {
    return Errors.notFound("User not found").toResponse();
  }

  if (field === "displayname") {
    return c.json({ displayname: user.display_name });
  } else if (field === "avatar_url") {
    return c.json({ avatar_url: user.avatar_url });
  }

  return c.json({
    displayname: user.display_name,
    avatar_url: user.avatar_url,
  });
});

// ============================================
// Federation E2EE Endpoints
// Required for cross-server encrypted messaging
// ============================================

// Helper to get UserKeys Durable Object for a user
function getUserKeysDO(
  env: typeof app extends Hono<infer E> ? E["Bindings"] : never,
  userId: string,
): DurableObjectStub {
  const id = env.USER_KEYS.idFromName(userId);
  return env.USER_KEYS.get(id);
}

// Helper to get device keys from Durable Object
async function getDeviceKeysFromDO(
  env: typeof app extends Hono<infer E> ? E["Bindings"] : never,
  userId: string,
  deviceId?: string,
): Promise<any> {
  const stub = getUserKeysDO(env, userId);
  const url = deviceId
    ? `http://internal/device-keys/get?device_id=${encodeURIComponent(deviceId)}`
    : "http://internal/device-keys/get";
  const response = await stub.fetch(new Request(url));
  if (!response.ok) {
    return deviceId ? null : {};
  }
  return await response.json();
}

// Helper to get cross-signing keys from Durable Object
async function getCrossSigningKeysFromDO(
  env: typeof app extends Hono<infer E> ? E["Bindings"] : never,
  userId: string,
): Promise<{
  master?: any;
  self_signing?: any;
  user_signing?: any;
}> {
  const stub = getUserKeysDO(env, userId);
  const response = await stub.fetch(new Request("http://internal/cross-signing/get"));
  if (!response.ok) {
    return {};
  }
  return await response.json();
}

// POST /_matrix/federation/v1/user/keys/query - Query device keys for local users
// This endpoint is called by remote servers to get device keys for E2EE
app.post("/_matrix/federation/v1/user/keys/query", async (c) => {
  const serverName = c.env.SERVER_NAME;
  const db = c.env.DB;

  let body: {
    device_keys?: Record<string, string[]>;
  };

  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  const requestedKeys = body.device_keys;
  if (!requestedKeys || typeof requestedKeys !== "object") {
    return Errors.missingParam("device_keys").toResponse();
  }

  const deviceKeys: Record<string, Record<string, any>> = {};
  const masterKeys: Record<string, any> = {};
  const selfSigningKeys: Record<string, any> = {};

  // Helper to merge signatures from D1 into device keys
  async function mergeSignaturesForDevice(
    userId: string,
    deviceId: string,
    deviceKey: any,
  ): Promise<any> {
    const dbSignatures = await db
      .prepare(`
      SELECT signer_user_id, signer_key_id, signature
      FROM cross_signing_signatures
      WHERE user_id = ? AND key_id = ?
    `)
      .bind(userId, deviceId)
      .all<{
        signer_user_id: string;
        signer_key_id: string;
        signature: string;
      }>();

    if (dbSignatures.results.length > 0) {
      deviceKey.signatures = deviceKey.signatures || {};
      for (const sig of dbSignatures.results) {
        deviceKey.signatures[sig.signer_user_id] = deviceKey.signatures[sig.signer_user_id] || {};
        deviceKey.signatures[sig.signer_user_id][sig.signer_key_id] = sig.signature;
      }
    }

    return deviceKey;
  }

  for (const [userId, requestedDevices] of Object.entries(requestedKeys)) {
    // Verify user is local to this server
    const userServerName = userId.split(":")[1];
    if (userServerName !== serverName) {
      // Skip non-local users - federation should query their home server
      continue;
    }

    // Check if user exists locally
    const user = await db
      .prepare(`SELECT user_id FROM users WHERE user_id = ?`)
      .bind(userId)
      .first<{ user_id: string }>();

    if (!user) {
      continue;
    }

    deviceKeys[userId] = {};

    // Get device keys from Durable Object (strongly consistent)
    if (!requestedDevices || requestedDevices.length === 0) {
      // Get all devices for this user
      const allDeviceKeys = await getDeviceKeysFromDO(c.env, userId);
      for (const [deviceId, keys] of Object.entries(allDeviceKeys)) {
        if (keys) {
          deviceKeys[userId][deviceId] = await mergeSignaturesForDevice(userId, deviceId, keys);
        }
      }
    } else {
      // Get specific devices
      for (const deviceId of requestedDevices) {
        const keys = await getDeviceKeysFromDO(c.env, userId, deviceId);
        if (keys) {
          deviceKeys[userId][deviceId] = await mergeSignaturesForDevice(userId, deviceId, keys);
        }
      }
    }

    // Get cross-signing keys (master + self_signing only for federation)
    // Note: user_signing key is NOT included in federation responses per spec
    const csKeys = await getCrossSigningKeysFromDO(c.env, userId);

    if (csKeys.master) {
      masterKeys[userId] = csKeys.master;
    }
    if (csKeys.self_signing) {
      selfSigningKeys[userId] = csKeys.self_signing;
    }
  }

  return c.json({
    device_keys: deviceKeys,
    master_keys: masterKeys,
    self_signing_keys: selfSigningKeys,
  });
});

// POST /_matrix/federation/v1/user/keys/claim - Claim one-time keys for E2EE session establishment
// Remote servers call this to get OTKs to establish encrypted sessions with local users
app.post("/_matrix/federation/v1/user/keys/claim", async (c) => {
  const serverName = c.env.SERVER_NAME;
  const db = c.env.DB;

  let body: {
    one_time_keys?: Record<string, Record<string, string>>;
  };

  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  const requestedKeys = body.one_time_keys;
  if (!requestedKeys || typeof requestedKeys !== "object") {
    return Errors.missingParam("one_time_keys").toResponse();
  }

  const oneTimeKeys: Record<string, Record<string, Record<string, any>>> = {};

  for (const [userId, devices] of Object.entries(requestedKeys)) {
    // Verify user is local to this server
    const userServerName = userId.split(":")[1];
    if (userServerName !== serverName) {
      continue;
    }

    oneTimeKeys[userId] = {};

    for (const [deviceId, algorithm] of Object.entries(devices)) {
      // Try to claim a one-time key from KV first (fast path)
      const existingKeys = (await c.env.ONE_TIME_KEYS.get(
        `otk:${userId}:${deviceId}`,
        "json",
      )) as Record<string, { keyId: string; keyData: any; claimed: boolean }[]> | null;

      let foundKey = false;

      if (existingKeys && existingKeys[algorithm]) {
        // Find first unclaimed key
        const keyIndex = existingKeys[algorithm].findIndex((k) => !k.claimed);
        if (keyIndex >= 0) {
          const key = existingKeys[algorithm][keyIndex];
          // Mark as claimed
          existingKeys[algorithm][keyIndex].claimed = true;

          // Save back to KV
          await c.env.ONE_TIME_KEYS.put(`otk:${userId}:${deviceId}`, JSON.stringify(existingKeys));

          // Also mark in D1
          await db
            .prepare(`
            UPDATE one_time_keys SET claimed = 1, claimed_at = ?
            WHERE user_id = ? AND device_id = ? AND key_id = ?
          `)
            .bind(Date.now(), userId, deviceId, key.keyId)
            .run();

          oneTimeKeys[userId][deviceId] = {
            [key.keyId]: key.keyData,
          };
          foundKey = true;
        }
      }

      if (!foundKey) {
        // Fallback to D1 for keys not in KV
        const otk = await db
          .prepare(`
          SELECT id, key_id, key_data FROM one_time_keys
          WHERE user_id = ? AND device_id = ? AND algorithm = ? AND claimed = 0
          LIMIT 1
        `)
          .bind(userId, deviceId, algorithm)
          .first<{
            id: number;
            key_id: string;
            key_data: string;
          }>();

        if (otk) {
          // Mark as claimed
          await db
            .prepare(`
            UPDATE one_time_keys SET claimed = 1, claimed_at = ? WHERE id = ?
          `)
            .bind(Date.now(), otk.id)
            .run();

          oneTimeKeys[userId][deviceId] = {
            [otk.key_id]: JSON.parse(otk.key_data),
          };
          foundKey = true;
        }
      }

      if (!foundKey) {
        // Try fallback key as last resort
        const fallback = await db
          .prepare(`
          SELECT key_id, key_data, used FROM fallback_keys
          WHERE user_id = ? AND device_id = ? AND algorithm = ?
        `)
          .bind(userId, deviceId, algorithm)
          .first<{
            key_id: string;
            key_data: string;
            used: number;
          }>();

        if (fallback) {
          // Mark fallback as used
          await db
            .prepare(`
            UPDATE fallback_keys SET used = 1 WHERE user_id = ? AND device_id = ? AND algorithm = ?
          `)
            .bind(userId, deviceId, algorithm)
            .run();

          const keyData = JSON.parse(fallback.key_data);
          oneTimeKeys[userId][deviceId] = {
            [fallback.key_id]: {
              ...keyData,
              fallback: true,
            },
          };
        }
      }
    }
  }

  return c.json({
    one_time_keys: oneTimeKeys,
  });
});

// GET /_matrix/federation/v1/user/devices/:userId - Get device list for a local user
// Remote servers call this to get the list of devices for a user
app.get("/_matrix/federation/v1/user/devices/:userId", async (c) => {
  const serverName = c.env.SERVER_NAME;
  const userId = c.req.param("userId");
  const db = c.env.DB;

  // Verify user is local to this server
  const userServerName = userId.split(":")[1];
  if (userServerName !== serverName) {
    return c.json(
      {
        errcode: "M_FORBIDDEN",
        error: "User is not local to this server",
      },
      403,
    );
  }

  // Check if user exists
  const user = await db
    .prepare(`SELECT user_id FROM users WHERE user_id = ?`)
    .bind(userId)
    .first<{ user_id: string }>();

  if (!user) {
    return Errors.notFound("User not found").toResponse();
  }

  // Get all devices from D1 (for display names)
  const dbDevices = await db
    .prepare(`SELECT device_id, display_name FROM devices WHERE user_id = ?`)
    .bind(userId)
    .all<{ device_id: string; display_name: string | null }>();

  // Get device keys from Durable Object (strongly consistent)
  const allDeviceKeys = await getDeviceKeysFromDO(c.env, userId);

  // Get stream_id for device key changes
  const streamPosition = await db
    .prepare(`SELECT MAX(stream_position) as stream_id FROM device_key_changes WHERE user_id = ?`)
    .bind(userId)
    .first<{ stream_id: number | null }>();

  // Build device list
  const devices: Array<{
    device_id: string;
    keys?: any;
    device_display_name?: string;
  }> = [];

  for (const dbDevice of dbDevices.results) {
    const deviceKeys = allDeviceKeys[dbDevice.device_id];
    devices.push({
      device_id: dbDevice.device_id,
      keys: deviceKeys || undefined,
      device_display_name: dbDevice.display_name || undefined,
    });
  }

  // Get cross-signing keys (master + self_signing only for federation)
  const csKeys = await getCrossSigningKeysFromDO(c.env, userId);

  const response: any = {
    user_id: userId,
    stream_id: streamPosition?.stream_id || 0,
    devices,
  };

  // Add cross-signing keys if present
  if (csKeys.master) {
    response.master_key = csKeys.master;
  }
  if (csKeys.self_signing) {
    response.self_signing_key = csKeys.self_signing;
  }

  return c.json(response);
});

// ============================================
// Knock Protocol Endpoints
// Allows users to request to join rooms
// ============================================

// GET /_matrix/federation/v1/make_knock/:roomId/:userId - Prepare knock request
// Remote servers call this to get a knock event template
app.get("/_matrix/federation/v1/make_knock/:roomId/:userId", async (c) => {
  const roomId = c.req.param("roomId");
  const userId = c.req.param("userId");
  const db = c.env.DB;

  // Check if room exists
  const room = await db
    .prepare(`SELECT room_id, room_version FROM rooms WHERE room_id = ?`)
    .bind(roomId)
    .first<{ room_id: string; room_version: string }>();

  if (!room) {
    return Errors.notFound("Room not found").toResponse();
  }

  // Get join_rules to verify room allows knocking
  const joinRulesEvent = await db
    .prepare(`
    SELECT e.content FROM room_state rs
    JOIN events e ON rs.event_id = e.event_id
    WHERE rs.room_id = ? AND rs.event_type = 'm.room.join_rules'
  `)
    .bind(roomId)
    .first<{ content: string }>();

  if (joinRulesEvent) {
    const joinRules = JSON.parse(joinRulesEvent.content);
    if (joinRules.join_rule !== "knock" && joinRules.join_rule !== "knock_restricted") {
      return c.json(
        {
          errcode: "M_FORBIDDEN",
          error: "Room does not allow knocking",
        },
        403,
      );
    }
  } else {
    // Default join_rule is 'invite', knocking not allowed
    return c.json(
      {
        errcode: "M_FORBIDDEN",
        error: "Room does not allow knocking",
      },
      403,
    );
  }

  // Check if user is already banned
  const membership = await db
    .prepare(`SELECT membership FROM room_memberships WHERE room_id = ? AND user_id = ?`)
    .bind(roomId, userId)
    .first<{ membership: string }>();

  if (membership?.membership === "ban") {
    return c.json(
      {
        errcode: "M_FORBIDDEN",
        error: "User is banned from this room",
      },
      403,
    );
  }

  if (membership?.membership === "join") {
    return c.json(
      {
        errcode: "M_FORBIDDEN",
        error: "User is already a member of this room",
      },
      403,
    );
  }

  // Get auth events for knock
  const createEvent = await db
    .prepare(`
    SELECT e.event_id FROM room_state rs
    JOIN events e ON rs.event_id = e.event_id
    WHERE rs.room_id = ? AND rs.event_type = 'm.room.create'
  `)
    .bind(roomId)
    .first<{ event_id: string }>();

  const joinRulesEventId = await db
    .prepare(`
    SELECT e.event_id FROM room_state rs
    JOIN events e ON rs.event_id = e.event_id
    WHERE rs.room_id = ? AND rs.event_type = 'm.room.join_rules'
  `)
    .bind(roomId)
    .first<{ event_id: string }>();

  const powerLevelsEvent = await db
    .prepare(`
    SELECT e.event_id FROM room_state rs
    JOIN events e ON rs.event_id = e.event_id
    WHERE rs.room_id = ? AND rs.event_type = 'm.room.power_levels'
  `)
    .bind(roomId)
    .first<{ event_id: string }>();

  const authEvents: string[] = [];
  if (createEvent) authEvents.push(createEvent.event_id);
  if (joinRulesEventId) authEvents.push(joinRulesEventId.event_id);
  if (powerLevelsEvent) authEvents.push(powerLevelsEvent.event_id);

  // Get latest event for prev_events
  const latestEvent = await db
    .prepare(`SELECT event_id, depth FROM events WHERE room_id = ? ORDER BY depth DESC LIMIT 1`)
    .bind(roomId)
    .first<{ event_id: string; depth: number }>();

  const prevEvents = latestEvent ? [latestEvent.event_id] : [];
  const depth = (latestEvent?.depth || 0) + 1;

  // Create unsigned knock event template
  const eventTemplate = {
    room_id: roomId,
    sender: userId,
    type: "m.room.member",
    state_key: userId,
    content: {
      membership: "knock",
    },
    origin_server_ts: Date.now(),
    depth,
    auth_events: authEvents,
    prev_events: prevEvents,
  };

  return c.json({
    room_version: room.room_version,
    event: eventTemplate,
  });
});

// PUT /_matrix/federation/v1/send_knock/:roomId/:eventId - Complete knock
// Remote servers call this to finalize the knock with a signed event
app.put("/_matrix/federation/v1/send_knock/:roomId/:eventId", async (c) => {
  const roomId = c.req.param("roomId");
  const eventId = c.req.param("eventId");
  const db = c.env.DB;

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  let validatedKnock;
  try {
    validatedKnock = await runDomainValidation(validateSendKnockRequest({ body, roomId, eventId }));
  } catch (error) {
    const response = toFederationErrorResponse(error);
    if (response) {
      return response;
    }
    throw error;
  }

  // Verify room exists
  const room = await db
    .prepare(`SELECT room_id FROM rooms WHERE room_id = ?`)
    .bind(roomId)
    .first<{ room_id: string }>();

  if (!room) {
    return Errors.notFound("Room not found").toResponse();
  }

  // Verify room allows knocking
  const joinRulesEvent = await db
    .prepare(`
    SELECT e.content FROM room_state rs
    JOIN events e ON rs.event_id = e.event_id
    WHERE rs.room_id = ? AND rs.event_type = 'm.room.join_rules'
  `)
    .bind(roomId)
    .first<{ content: string }>();

  if (joinRulesEvent) {
    const joinRules = JSON.parse(joinRulesEvent.content);
    if (joinRules.join_rule !== "knock" && joinRules.join_rule !== "knock_restricted") {
      return c.json(
        {
          errcode: "M_FORBIDDEN",
          error: "Room does not allow knocking",
        },
        403,
      );
    }
  } else {
    return c.json(
      {
        errcode: "M_FORBIDDEN",
        error: "Room does not allow knocking",
      },
      403,
    );
  }

  // Check if user is already banned or joined
  const userId = validatedKnock.event.state_key;
  const membership = await db
    .prepare(`SELECT membership FROM room_memberships WHERE room_id = ? AND user_id = ?`)
    .bind(roomId, userId)
    .first<{ membership: string }>();

  if (membership?.membership === "ban") {
    return c.json(
      {
        errcode: "M_FORBIDDEN",
        error: "User is banned from this room",
      },
      403,
    );
  }

  if (membership?.membership === "join") {
    return c.json(
      {
        errcode: "M_FORBIDDEN",
        error: "User is already a member of this room",
      },
      403,
    );
  }

  const knockPdu = validatedKnock.event;

  try {
    await persistFederationMembershipEvent(db, {
      roomId,
      event: knockPdu,
      source: "federation",
    });
    await notifyUsersOfEvent(c.env, roomId, eventId, "m.room.member");
    c.executionCtx.waitUntil(fanoutEventToFederation(c.env, roomId, knockPdu));
  } catch (e) {
    console.error(`Failed to store knock event ${eventId}:`, e);
  }

  // Return stripped state events — spec requires m.room.create plus name/avatar/join_rules/canonical_alias
  const strippedState: any[] = [];

  // Get m.room.create (required by spec)
  const createEvent = await db
    .prepare(`
    SELECT e.event_type, e.state_key, e.content, e.sender
    FROM room_state rs
    JOIN events e ON rs.event_id = e.event_id
    WHERE rs.room_id = ? AND rs.event_type = 'm.room.create'
  `)
    .bind(roomId)
    .first<{
      event_type: string;
      state_key: string;
      content: string;
      sender: string;
    }>();

  if (createEvent) {
    strippedState.push({
      type: createEvent.event_type,
      state_key: createEvent.state_key,
      content: JSON.parse(createEvent.content),
      sender: createEvent.sender,
    });
  }

  // Get room name
  const nameEvent = await db
    .prepare(`
    SELECT e.event_type, e.state_key, e.content, e.sender, e.origin_server_ts
    FROM room_state rs
    JOIN events e ON rs.event_id = e.event_id
    WHERE rs.room_id = ? AND rs.event_type = 'm.room.name'
  `)
    .bind(roomId)
    .first<{
      event_type: string;
      state_key: string;
      content: string;
      sender: string;
      origin_server_ts: number;
    }>();

  if (nameEvent) {
    strippedState.push({
      type: nameEvent.event_type,
      state_key: nameEvent.state_key,
      content: JSON.parse(nameEvent.content),
      sender: nameEvent.sender,
    });
  }

  // Get room avatar
  const avatarEvent = await db
    .prepare(`
    SELECT e.event_type, e.state_key, e.content, e.sender
    FROM room_state rs
    JOIN events e ON rs.event_id = e.event_id
    WHERE rs.room_id = ? AND rs.event_type = 'm.room.avatar'
  `)
    .bind(roomId)
    .first<{
      event_type: string;
      state_key: string;
      content: string;
      sender: string;
    }>();

  if (avatarEvent) {
    strippedState.push({
      type: avatarEvent.event_type,
      state_key: avatarEvent.state_key,
      content: JSON.parse(avatarEvent.content),
      sender: avatarEvent.sender,
    });
  }

  // Get join_rules
  if (joinRulesEvent) {
    const joinRulesEventFull = await db
      .prepare(`
      SELECT e.event_type, e.state_key, e.content, e.sender
      FROM room_state rs
      JOIN events e ON rs.event_id = e.event_id
      WHERE rs.room_id = ? AND rs.event_type = 'm.room.join_rules'
    `)
      .bind(roomId)
      .first<{
        event_type: string;
        state_key: string;
        content: string;
        sender: string;
      }>();

    if (joinRulesEventFull) {
      strippedState.push({
        type: joinRulesEventFull.event_type,
        state_key: joinRulesEventFull.state_key,
        content: JSON.parse(joinRulesEventFull.content),
        sender: joinRulesEventFull.sender,
      });
    }
  }

  // Get canonical alias
  const aliasEvent = await db
    .prepare(`
    SELECT e.event_type, e.state_key, e.content, e.sender
    FROM room_state rs
    JOIN events e ON rs.event_id = e.event_id
    WHERE rs.room_id = ? AND rs.event_type = 'm.room.canonical_alias'
  `)
    .bind(roomId)
    .first<{
      event_type: string;
      state_key: string;
      content: string;
      sender: string;
    }>();

  if (aliasEvent) {
    strippedState.push({
      type: aliasEvent.event_type,
      state_key: aliasEvent.state_key,
      content: JSON.parse(aliasEvent.content),
      sender: aliasEvent.sender,
    });
  }

  return c.json({
    knock_room_state: strippedState,
  });
});

// ============================================
// Federation Media Endpoints
// Serve local media to remote servers
// ============================================

// GET /_matrix/federation/v1/media/download/:mediaId - Download media via federation
app.get("/_matrix/federation/v1/media/download/:mediaId", async (c) => {
  const mediaId = c.req.param("mediaId");

  // Get media from R2
  const object = await c.env.MEDIA.get(mediaId);
  if (!object) {
    return Errors.notFound("Media not found").toResponse();
  }

  // Get metadata from D1
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

// GET /_matrix/federation/v1/media/thumbnail/:mediaId - Get thumbnail via federation
app.get("/_matrix/federation/v1/media/thumbnail/:mediaId", async (c) => {
  const mediaId = c.req.param("mediaId");
  const width = Math.min(parseInt(c.req.query("width") || "96"), 1920);
  const height = Math.min(parseInt(c.req.query("height") || "96"), 1920);
  const method = c.req.query("method") || "scale";

  // Get media metadata
  const metadata = await c.env.DB.prepare(`SELECT content_type FROM media WHERE media_id = ?`)
    .bind(mediaId)
    .first<{ content_type: string }>();

  if (!metadata) {
    return Errors.notFound("Media not found").toResponse();
  }

  const isImage = metadata.content_type.startsWith("image/");

  // Check for pre-generated thumbnail
  const thumbnailKey = `thumb_${mediaId}_${width}x${height}_${method}`;
  const existingThumb = await c.env.MEDIA.get(thumbnailKey);

  if (existingThumb) {
    const headers = new Headers();
    headers.set("Content-Type", "image/jpeg");
    headers.set("Cache-Control", "public, max-age=31536000, immutable");
    return new Response(existingThumb.body, { headers });
  }

  // Get original
  const object = await c.env.MEDIA.get(mediaId);
  if (!object) {
    return Errors.notFound("Media not found").toResponse();
  }

  // If not an image, return original
  const headers = new Headers();
  headers.set("Content-Type", metadata.content_type);
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  if (isImage) {
    headers.set("X-Thumbnail-Generated", "false");
  }

  return new Response(object.body, { headers });
});

// ============================================
// Federation Public Rooms Directory
// ============================================

// GET /_matrix/federation/v1/publicRooms - Get public rooms
app.get("/_matrix/federation/v1/publicRooms", async (c) => {
  const db = c.env.DB;
  const serverName = c.env.SERVER_NAME;

  const limit = Math.min(parseInt(c.req.query("limit") || "100"), 500);
  const since = c.req.query("since");
  // Note: include_all_networks reserved for future use
  void c.req.query("include_all_networks");

  // Parse since token for pagination (format: "offset_N")
  let offset = 0;
  if (since && since.startsWith("offset_")) {
    offset = parseInt(since.substring(7), 10) || 0;
  }

  // Query public rooms
  const rooms = await db
    .prepare(`
    SELECT r.room_id
    FROM rooms r
    WHERE r.is_public = 1
    ORDER BY r.created_at DESC
    LIMIT ? OFFSET ?
  `)
    .bind(limit + 1, offset)
    .all<{ room_id: string }>();

  const hasMore = rooms.results.length > limit;
  const roomResults = rooms.results.slice(0, limit);

  // Build room chunks
  const chunks: any[] = [];

  for (const room of roomResults) {
    const roomInfo = await getRoomPublicInfo(db, room.room_id, serverName);
    if (roomInfo) {
      chunks.push(roomInfo);
    }
  }

  // Count total
  const totalCount = await db
    .prepare(`
    SELECT COUNT(*) as count FROM rooms WHERE is_public = 1
  `)
    .first<{ count: number }>();

  const response: any = {
    chunk: chunks,
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

// POST /_matrix/federation/v1/publicRooms - Search public rooms
app.post("/_matrix/federation/v1/publicRooms", async (c) => {
  const db = c.env.DB;
  const serverName = c.env.SERVER_NAME;

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

  // Parse since token
  let offset = 0;
  if (since && since.startsWith("offset_")) {
    offset = parseInt(since.substring(7), 10) || 0;
  }

  // Query public rooms with optional search
  let rooms;
  if (searchTerm) {
    rooms = await db
      .prepare(`
      SELECT DISTINCT r.room_id
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
      LIMIT ? OFFSET ?
    `)
      .bind(`%${searchTerm}%`, `%${searchTerm}%`, `%${searchTerm}%`, limit + 1, offset)
      .all<{ room_id: string }>();
  } else {
    rooms = await db
      .prepare(`
      SELECT r.room_id
      FROM rooms r
      WHERE r.is_public = 1
      ORDER BY r.created_at DESC
      LIMIT ? OFFSET ?
    `)
      .bind(limit + 1, offset)
      .all<{ room_id: string }>();
  }

  const hasMore = rooms.results.length > limit;
  const roomResults = rooms.results.slice(0, limit);

  // Build room chunks
  const chunks: any[] = [];

  for (const room of roomResults) {
    const roomInfo = await getRoomPublicInfo(db, room.room_id, serverName);
    if (roomInfo) {
      chunks.push(roomInfo);
    }
  }

  // Count total
  const totalCount = await db
    .prepare(`
    SELECT COUNT(*) as count FROM rooms WHERE is_public = 1
  `)
    .first<{ count: number }>();

  const response: any = {
    chunk: chunks,
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

// Helper to get public room info
async function getRoomPublicInfo(
  db: D1Database,
  roomId: string,
  _serverName: string,
): Promise<any> {
  // Get room name
  const nameEvent = await db
    .prepare(`
    SELECT e.content FROM room_state rs
    JOIN events e ON rs.event_id = e.event_id
    WHERE rs.room_id = ? AND rs.event_type = 'm.room.name'
  `)
    .bind(roomId)
    .first<{ content: string }>();

  // Get room topic
  const topicEvent = await db
    .prepare(`
    SELECT e.content FROM room_state rs
    JOIN events e ON rs.event_id = e.event_id
    WHERE rs.room_id = ? AND rs.event_type = 'm.room.topic'
  `)
    .bind(roomId)
    .first<{ content: string }>();

  // Get canonical alias
  const aliasEvent = await db
    .prepare(`
    SELECT e.content FROM room_state rs
    JOIN events e ON rs.event_id = e.event_id
    WHERE rs.room_id = ? AND rs.event_type = 'm.room.canonical_alias'
  `)
    .bind(roomId)
    .first<{ content: string }>();

  // Get avatar
  const avatarEvent = await db
    .prepare(`
    SELECT e.content FROM room_state rs
    JOIN events e ON rs.event_id = e.event_id
    WHERE rs.room_id = ? AND rs.event_type = 'm.room.avatar'
  `)
    .bind(roomId)
    .first<{ content: string }>();

  // Get join rule
  const joinRuleEvent = await db
    .prepare(`
    SELECT e.content FROM room_state rs
    JOIN events e ON rs.event_id = e.event_id
    WHERE rs.room_id = ? AND rs.event_type = 'm.room.join_rules'
  `)
    .bind(roomId)
    .first<{ content: string }>();

  // Get history visibility
  const historyEvent = await db
    .prepare(`
    SELECT e.content FROM room_state rs
    JOIN events e ON rs.event_id = e.event_id
    WHERE rs.room_id = ? AND rs.event_type = 'm.room.history_visibility'
  `)
    .bind(roomId)
    .first<{ content: string }>();

  // Get guest access
  const guestEvent = await db
    .prepare(`
    SELECT e.content FROM room_state rs
    JOIN events e ON rs.event_id = e.event_id
    WHERE rs.room_id = ? AND rs.event_type = 'm.room.guest_access'
  `)
    .bind(roomId)
    .first<{ content: string }>();

  // Get member count
  const memberCount = await db
    .prepare(`
    SELECT COUNT(*) as count FROM room_memberships WHERE room_id = ? AND membership = 'join'
  `)
    .bind(roomId)
    .first<{ count: number }>();

  // Get room type
  const createEvent = await db
    .prepare(`
    SELECT e.content FROM room_state rs
    JOIN events e ON rs.event_id = e.event_id
    WHERE rs.room_id = ? AND rs.event_type = 'm.room.create'
  `)
    .bind(roomId)
    .first<{ content: string }>();

  let roomType: string | undefined;
  if (createEvent) {
    try {
      const content = JSON.parse(createEvent.content);
      roomType = content.type;
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

// GET /_matrix/federation/v1/openid/userinfo - Validate OpenID token and return user info
app.get("/_matrix/federation/v1/openid/userinfo", async (c) => {
  const accessToken = c.req.query("access_token");

  if (!accessToken) {
    return Errors.missingParam("access_token").toResponse();
  }

  // Look up the OpenID token in KV
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

  // Check if token has expired
  if (Date.now() > tokenData.expires_at) {
    // Clean up expired token
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

// PUT /_matrix/federation/v1/exchange_third_party_invite/:roomId - Exchange 3PID invite
// Handles third-party invites when a user accepts an invite via their verified email/phone
app.put("/_matrix/federation/v1/exchange_third_party_invite/:roomId", async (c) => {
  const roomId = c.req.param("roomId");
  const db = c.env.DB;
  const serverName = c.env.SERVER_NAME;

  let body: unknown;

  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  let validated: FederationThirdPartyInviteValidationResult;
  try {
    validated = await runDomainValidation(validateThirdPartyInviteExchangeRequest({ body, roomId }));
  } catch (error) {
    const response = toFederationErrorResponse(error);
    if (response) {
      return response;
    }
    throw error;
  }

  const { mxid, token, signatures } = validated.signed;

  // Verify room exists
  const room = await db
    .prepare(`
    SELECT room_id, room_version FROM rooms WHERE room_id = ?
  `)
    .bind(roomId)
    .first<{ room_id: string; room_version: string }>();

  if (!room) {
    return Errors.notFound("Room not found").toResponse();
  }

  // Find the matching m.room.third_party_invite state event
  const thirdPartyInviteEvent = await db
    .prepare(`
    SELECT e.event_id, e.content, e.sender, e.state_key
    FROM room_state rs
    JOIN events e ON rs.event_id = e.event_id
    WHERE rs.room_id = ? AND rs.event_type = 'm.room.third_party_invite' AND rs.state_key = ?
  `)
    .bind(roomId, token)
    .first<{
      event_id: string;
      content: string;
      sender: string;
      state_key: string;
    }>();

  if (!thirdPartyInviteEvent) {
    return c.json(
      {
        errcode: "M_FORBIDDEN",
        error: "No third party invite found with matching token",
      },
      403,
    );
  }

  // Parse the third-party invite content to get the public keys
  let inviteContent: {
    display_name?: string;
    key_validity_url?: string;
    public_key?: string;
    public_keys?: Array<{ public_key: string; key_validity_url?: string }>;
  };

  try {
    inviteContent = JSON.parse(thirdPartyInviteEvent.content);
  } catch {
    return c.json(
      {
        errcode: "M_INVALID_PARAM",
        error: "Invalid third party invite content",
      },
      400,
    );
  }

  // Verify the signature against the public keys in the invite
  // The signed object format is: { mxid, sender, token, signatures }
  // where sender is from the original third_party_invite event
  const signedDataForVerification: Record<string, unknown> = {
    mxid,
    sender: thirdPartyInviteEvent.sender,
    token,
    signatures,
  };

  let signatureValid = false;
  const publicKeys = inviteContent.public_keys || [];
  if (inviteContent.public_key) {
    publicKeys.push({ public_key: inviteContent.public_key });
  }

  // Try to verify with each public key
  for (const keyInfo of publicKeys) {
    const publicKey = keyInfo.public_key;
    if (!publicKey) continue;

    // Look for a signature from the identity server
    // Signatures are keyed by server name (typically the identity server)
    for (const [signingServer, keySignatures] of Object.entries(signatures)) {
      for (const [keyId, signature] of Object.entries(keySignatures)) {
        if (!signature) continue;

        try {
          // Verify the Ed25519 signature using the public key from the invite
          const isValid = await verifySignature(
            signedDataForVerification,
            signingServer,
            keyId,
            publicKey,
          );

          if (isValid) {
            signatureValid = true;
            break;
          }
        } catch (e) {
          console.warn(`Failed to verify signature from ${signingServer}:${keyId}:`, e);
        }
      }
      if (signatureValid) break;
    }
    if (signatureValid) break;
  }

  if (!signatureValid) {
    return c.json(
      {
        errcode: "M_FORBIDDEN",
        error: "Could not verify third party invite signature",
      },
      403,
    );
  }

  // Verify the mxid matches the state_key
  // Get our signing key
  const key = await db
    .prepare(
      `SELECT key_id, private_key_jwk FROM server_keys WHERE is_current = 1 AND key_version = 2`,
    )
    .first<{ key_id: string; private_key_jwk: string | null }>();

  if (!key || !key.private_key_jwk) {
    return c.json(
      {
        errcode: "M_UNKNOWN",
        error: "Server signing key not configured",
      },
      500,
    );
  }

  // Get auth events for the invite
  const createEvent = await db
    .prepare(`
    SELECT e.event_id FROM room_state rs
    JOIN events e ON rs.event_id = e.event_id
    WHERE rs.room_id = ? AND rs.event_type = 'm.room.create'
  `)
    .bind(roomId)
    .first<{ event_id: string }>();

  const joinRulesEvent = await db
    .prepare(`
    SELECT e.event_id FROM room_state rs
    JOIN events e ON rs.event_id = e.event_id
    WHERE rs.room_id = ? AND rs.event_type = 'm.room.join_rules'
  `)
    .bind(roomId)
    .first<{ event_id: string }>();

  const powerLevelsEvent = await db
    .prepare(`
    SELECT e.event_id FROM room_state rs
    JOIN events e ON rs.event_id = e.event_id
    WHERE rs.room_id = ? AND rs.event_type = 'm.room.power_levels'
  `)
    .bind(roomId)
    .first<{ event_id: string }>();

  const senderMembershipEvent = await db
    .prepare(`
    SELECT e.event_id FROM room_state rs
    JOIN events e ON rs.event_id = e.event_id
    WHERE rs.room_id = ? AND rs.event_type = 'm.room.member' AND rs.state_key = ?
  `)
    .bind(roomId, validated.sender)
    .first<{ event_id: string }>();

  const authEvents: string[] = [];
  if (createEvent) authEvents.push(createEvent.event_id);
  if (joinRulesEvent) authEvents.push(joinRulesEvent.event_id);
  if (powerLevelsEvent) authEvents.push(powerLevelsEvent.event_id);
  if (senderMembershipEvent) authEvents.push(senderMembershipEvent.event_id);
  authEvents.push(thirdPartyInviteEvent.event_id);

  // Get latest event for prev_events
  const latestEvent = await db
    .prepare(`SELECT event_id, depth FROM events WHERE room_id = ? ORDER BY depth DESC LIMIT 1`)
    .bind(roomId)
    .first<{ event_id: string; depth: number }>();

  const prevEvents = latestEvent ? [latestEvent.event_id] : [];
  const depth = (latestEvent?.depth || 0) + 1;
  const originServerTs = Date.now();

  // Create the invite event
  const inviteEvent = {
    room_id: roomId,
    sender: validated.sender,
    type: "m.room.member",
    state_key: mxid,
    content: {
      membership: "invite",
      third_party_invite: {
        display_name: inviteContent.display_name || validated.displayName,
        signed: validated.signed,
      },
    },
    origin_server_ts: originServerTs,
    depth,
    auth_events: authEvents,
    prev_events: prevEvents,
  };

  // Calculate event ID (for room versions 1-3, event_id is computed differently)
  // For room versions 4+, event_id is computed from the content hash
  const eventIdHash = await sha256(
    JSON.stringify({
      ...inviteEvent,
      origin: serverName,
    }),
  );
  const eventId = validated.eventId || `$${eventIdHash}`;

  // Sign the event
  const signedEvent = await signJson(
    { ...inviteEvent, event_id: eventId },
    serverName,
    key.key_id,
    JSON.parse(key.private_key_jwk),
  );

  // Store the event
  try {
    const storedPdu: PDU = {
      event_id: eventId,
      room_id: roomId,
      sender: validated.sender,
      type: "m.room.member",
      state_key: mxid,
      content: inviteEvent.content,
      origin_server_ts: originServerTs,
      depth,
      auth_events: authEvents,
      prev_events: prevEvents,
      signatures: (signedEvent as any).signatures,
    };
    await persistFederationMembershipEvent(db, {
      roomId,
      event: storedPdu,
      source: "federation",
    });

    // Delete the third party invite state event (it's been consumed)
    await db
      .prepare(`
      DELETE FROM room_state
      WHERE room_id = ? AND event_type = 'm.room.third_party_invite' AND state_key = ?
    `)
      .bind(roomId, token)
      .run();
  } catch (e) {
    console.error("Failed to store third party invite exchange event:", e);
    return c.json(
      {
        errcode: "M_UNKNOWN",
        error: "Failed to store invite event",
      },
      500,
    );
  }

  return c.json({});
});

export default app;
