// Spaces API
// Implements: https://spec.matrix.org/v1.12/client-server-api/#spaces
//
// Spaces are a way to organize rooms into hierarchical groups

import { Hono } from "hono";
import type { AppEnv } from "../types";
import { Errors } from "../utils/errors";
import { requireAuth } from "../middleware/auth";
import { EventQueryService, selectSpaceChildren } from "../matrix/application/event-query-service";

const app = new Hono<AppEnv>();
const queries = new EventQueryService();

// ============================================
// Types
// ============================================

interface SpaceChild {
  room_id: string;
  room_type?: string;
  name?: string;
  topic?: string;
  canonical_alias?: string;
  num_joined_members: number;
  avatar_url?: string;
  join_rule?: string;
  world_readable: boolean;
  guest_can_join: boolean;
  children_state: any[];
}

// ============================================
// Endpoints
// ============================================

// GET /_matrix/client/v1/rooms/:roomId/hierarchy - Get space hierarchy
app.get("/_matrix/client/v1/rooms/:roomId/hierarchy", requireAuth(), async (c) => {
  // Note: userId could be used for permission checks in future
  void c.get("userId");
  const roomId = c.req.param("roomId");
  if (!(await queries.roomExists(c.env.DB, roomId))) {
    return Errors.notFound("Room not found").toResponse();
  }

  // Get pagination params
  // Note: 'from' pagination param reserved for future use
  void c.req.query("from");
  const limit = Math.min(parseInt(c.req.query("limit") || "50"), 100);
  const maxDepth = parseInt(c.req.query("max_depth") || "1");
  const suggestedOnly = c.req.query("suggested_only") === "true";

  const childEdges = await queries.getSpaceChildEdges(c.env.DB, roomId);
  const { children: childEvents } = selectSpaceChildren(childEdges, {
    suggestedOnly,
    limit,
    offset: 0,
  });

  const rooms: SpaceChild[] = [];

  // Add the space itself first
  const spaceInfo = await getRoomInfo(c.env.DB, roomId, c.env.SERVER_NAME);
  if (spaceInfo) {
    rooms.push({
      ...spaceInfo,
      children_state: childEdges.map((ce) => ({
        type: "m.space.child",
        state_key: ce.roomId,
        content: ce.content,
        sender: "", // Would need to fetch from event
        origin_server_ts: 0,
      })),
    });
  }

  // Process each child
  for (const child of childEvents) {
    const childInfo = await getRoomInfo(c.env.DB, child.roomId, c.env.SERVER_NAME);
    if (!childInfo) {
      continue;
    }

    let childrenState: any[] = [];
    if (maxDepth > 1) {
      const grandchildEdges = await queries.getSpaceChildEdges(c.env.DB, child.roomId);
      childrenState = grandchildEdges.map((edge) => ({
        type: "m.space.child",
        state_key: edge.roomId,
        content: edge.content,
      }));
    }

    rooms.push({
      ...childInfo,
      children_state: childrenState,
    });
  }

  return c.json({
    rooms: rooms.slice(0, limit),
    next_batch: rooms.length > limit ? rooms[limit - 1].room_id : undefined,
  });
});

// Helper function to get room info
async function getRoomInfo(
  db: D1Database,
  roomId: string,
  _serverName: string,
): Promise<SpaceChild | null> {
  const info = await queries.getRoomPublicInfo(db, roomId);
  if (!info) {
    return null;
  }

  return {
    ...info,
    children_state: [],
  };
}

export default app;
