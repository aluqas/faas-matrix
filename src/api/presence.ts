// Presence API
// Implements: https://spec.matrix.org/v1.12/client-server-api/#presence
//
// Presence indicates whether users are online, offline, or unavailable.
// Status messages can also be set.

import { Hono } from "hono";
import type { AppEnv } from "../types";
import type { PresenceState } from "../types";
import { Errors } from "../utils/errors";
import { requireAuth } from "../middleware/auth";
import { queueFederationEdu } from "../matrix/application/features/shared/federation-edu-queue";
import { getSharedServersInRoomsWithUserIncludingPartialState } from "../matrix/application/features/partial-state/shared-servers";
import { executePresenceCommand } from "../matrix/application/features/presence/command";
import type { PresenceEduContent } from "../matrix/application/features/presence/contracts";
import {
  findPresenceByUserId,
  findPresenceByUserIds,
  touchLastActive as dbTouchLastActive,
  upsertPresence,
  writePresenceToCache,
} from "../matrix/repositories/presence-repository";

const app = new Hono<AppEnv>();

// ============================================
// Constants
// ============================================

// ============================================
// Endpoints
// ============================================

// PUT /_matrix/client/v3/presence/:userId/status - Set presence status
app.put("/_matrix/client/v3/presence/:userId/status", requireAuth(), async (c) => {
  const requestingUserId = c.get("userId");
  const targetUserId = c.req.param("userId");
  const db = c.env.DB;

  // Users can only set their own presence
  if (requestingUserId !== targetUserId) {
    return Errors.forbidden("Cannot set presence for other users").toResponse();
  }

  let body: { presence: string; status_msg?: string };
  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  const { presence, status_msg } = body;

  // Validate presence state
  const validStates = ["online", "offline", "unavailable"];
  if (!presence || !validStates.includes(presence)) {
    return c.json(
      {
        errcode: "M_INVALID_PARAM",
        error: `Invalid presence state: ${presence}. Must be one of: ${validStates.join(", ")}`,
      },
      400,
    );
  }

  try {
    await executePresenceCommand(
      {
        userId: requestingUserId,
        presence: presence as PresenceState,
        statusMessage: status_msg ?? null,
        now: Date.now(),
      },
      {
        localServerName: c.env.SERVER_NAME,
        async persistPresence(input) {
          await upsertPresence(
            db,
            input.userId,
            input.presence,
            input.statusMessage ?? null,
            input.now,
          );
          await writePresenceToCache(
            c.env.CACHE,
            input.userId,
            input.presence,
            input.statusMessage ?? null,
            input.now,
          );
        },
        resolveInterestedServers(userId: string) {
          return getSharedServersInRoomsWithUserIncludingPartialState(db, c.env.CACHE, userId);
        },
        async queueEdu(destination: string, content: PresenceEduContent) {
          await queueFederationEdu(c.env, destination, "m.presence", content);
        },
        debugEnabled: c.get("appContext").profile.name === "complement",
      },
    );
  } catch (err) {
    console.warn("[presence] Failed to queue federation EDUs:", err);
  }

  return c.json({});
});

// GET /_matrix/client/v3/presence/:userId/status - Get presence status
app.get("/_matrix/client/v3/presence/:userId/status", requireAuth(), async (c) => {
  const targetUserId = c.req.param("userId");
  const db = c.env.DB;

  // Check if target user exists
  const user = await db
    .prepare(`
    SELECT user_id FROM users WHERE user_id = ?
  `)
    .bind(targetUserId)
    .first();

  if (!user) {
    return Errors.notFound("User not found").toResponse();
  }

  const presenceRecord = await findPresenceByUserId(db, targetUserId, c.env.CACHE);
  if (!presenceRecord) {
    return c.json({
      presence: "offline",
      currently_active: false,
    });
  }

  return c.json({
    presence: presenceRecord.presence,
    ...(presenceRecord.statusMsg !== undefined ? { status_msg: presenceRecord.statusMsg } : {}),
    last_active_ago: presenceRecord.lastActiveAgo,
    currently_active: presenceRecord.currentlyActive,
  });
});

// ============================================
// Internal Helpers
// ============================================

// Get presence for multiple users (for sync)
export function getPresenceForUsers(db: D1Database, userIds: string[], cache?: KVNamespace) {
  return findPresenceByUserIds(db, userIds, cache);
}

// Update last active timestamp (call this on API activity)
export async function updateLastActive(db: D1Database, userId: string): Promise<void> {
  await dbTouchLastActive(db, userId);
}

export default app;
