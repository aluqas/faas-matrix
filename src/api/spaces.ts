// Spaces API
// Implements: https://spec.matrix.org/v1.12/client-server-api/#spaces
//
// Spaces are a way to organize rooms into hierarchical groups

import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../types";
import type {
  FederationSpaceHierarchyResponse,
  PublicRoomSummary,
  FederationSpaceHierarchyRoom,
  SpaceHierarchyChildStateEvent,
  SpaceHierarchyRoom,
  SpaceHierarchySnapshot,
} from "../types/client";
import { Errors } from "../utils/errors";
import { requireAuth } from "../middleware/auth";
import {
  EventQueryService,
  selectSpaceChildren,
  type SpaceChildEdge,
} from "../matrix/application/event-query-service";
import { federationGet } from "../services/federation-keys";

const app = new Hono<AppEnv>();
const queries = new EventQueryService();
type AppContext = Context<AppEnv>;

function filterHierarchyEdges(edges: SpaceChildEdge[], suggestedOnly: boolean): SpaceChildEdge[] {
  return selectSpaceChildren(edges, {
    suggestedOnly,
    limit: Number.MAX_SAFE_INTEGER,
    offset: 0,
  }).children;
}

function toChildrenState(edges: SpaceChildEdge[]): SpaceHierarchyChildStateEvent[] {
  return edges.map((edge) => ({
    type: "m.space.child",
    state_key: edge.roomId,
    content: edge.content,
    sender: "",
    origin_server_ts: 0,
  }));
}

function toSpaceChild(room: PublicRoomSummary, childEdges: SpaceChildEdge[]): SpaceHierarchyRoom {
  return {
    ...room,
    children_state: toChildrenState(childEdges),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseViaServers(content: Record<string, unknown>): string[] {
  const via = content.via;
  if (!Array.isArray(via)) {
    return [];
  }

  return via.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

function parseFederationRoom(
  room: FederationSpaceHierarchyRoom | null | undefined,
): SpaceHierarchyRoom | null {
  if (!room || typeof room.room_id !== "string") {
    return null;
  }

  const children_state = (Array.isArray(room.children_state) ? room.children_state : []).flatMap(
    (event) => {
      if (
        event?.type !== "m.space.child" ||
        typeof event.state_key !== "string" ||
        !isObject(event.content)
      ) {
        return [];
      }

      return [
        {
          type: "m.space.child" as const,
          state_key: event.state_key,
          content: event.content,
          sender: typeof event.sender === "string" ? event.sender : "",
          origin_server_ts: typeof event.origin_server_ts === "number" ? event.origin_server_ts : 0,
        },
      ];
    },
  );

  return {
    room_id: room.room_id,
    ...(typeof room.room_type === "string" ? { room_type: room.room_type } : {}),
    ...(typeof room.name === "string" ? { name: room.name } : {}),
    ...(typeof room.topic === "string" ? { topic: room.topic } : {}),
    ...(typeof room.canonical_alias === "string" ? { canonical_alias: room.canonical_alias } : {}),
    ...(typeof room.avatar_url === "string" ? { avatar_url: room.avatar_url } : {}),
    ...(typeof room.join_rule === "string" ? { join_rule: room.join_rule } : {}),
    num_joined_members: room.num_joined_members,
    world_readable: room.world_readable,
    guest_can_join: room.guest_can_join,
    children_state,
  };
}

async function loadLocalSnapshot(
  db: D1Database,
  roomId: string,
  suggestedOnly: boolean,
): Promise<SpaceHierarchySnapshot | null> {
  if (!(await queries.roomExists(db, roomId))) {
    return null;
  }

  const room = await queries.getRoomPublicInfo(db, roomId);
  if (!room) {
    return null;
  }

  const childEdges = filterHierarchyEdges(
    await queries.getSpaceChildEdges(db, roomId),
    suggestedOnly,
  );
  return {
    room: toSpaceChild(room, childEdges),
    childEdges,
  };
}

async function fetchRemoteSnapshot(
  c: AppContext,
  roomId: string,
  viaServers: string[],
  suggestedOnly: boolean,
): Promise<SpaceHierarchySnapshot | null> {
  const remoteTargets = viaServers.filter((server) => server !== c.env.SERVER_NAME);

  for (const server of remoteTargets) {
    try {
      const query = new URLSearchParams();
      query.set("limit", "100");
      if (suggestedOnly) {
        query.set("suggested_only", "true");
      }

      const response = await federationGet(
        server,
        `/_matrix/federation/v1/hierarchy/${encodeURIComponent(roomId)}?${query.toString()}`,
        c.env.SERVER_NAME,
        c.env.DB,
        c.env.CACHE,
      );
      if (!response.ok) {
        continue;
      }

      const body = await response.json();
      const room = parseFederationRoom(body.room);
      if (!room) {
        continue;
      }

      const childEdges = filterHierarchyEdges(
        room.children_state.map((event) => ({
          roomId: event.state_key,
          content: event.content,
        })),
        suggestedOnly,
      );

      return {
        room: {
          ...room,
          children_state: toChildrenState(childEdges),
        },
        childEdges,
      };
    } catch {
      continue;
    }
  }

  return null;
}

async function loadHierarchySnapshot(
  c: AppContext,
  roomId: string,
  viaServers: string[],
  suggestedOnly: boolean,
): Promise<SpaceHierarchySnapshot | null> {
  const local = await loadLocalSnapshot(c.env.DB, roomId, suggestedOnly);
  if (local) {
    return local;
  }

  return fetchRemoteSnapshot(c, roomId, viaServers, suggestedOnly);
}

app.get("/_matrix/client/v1/rooms/:roomId/hierarchy", requireAuth(), async (c) => {
  const userId = c.get("userId");
  const roomId = c.req.param("roomId");
  if (!(await queries.roomExists(c.env.DB, roomId))) {
    return Errors.notFound("Room not found").toResponse();
  }

  const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10), 100);
  const offsetToken = c.req.query("from");
  const offset =
    offsetToken && offsetToken.startsWith("offset_")
      ? Math.max(0, Number.parseInt(offsetToken.slice("offset_".length), 10) || 0)
      : 0;
  const maxDepth = Math.max(0, parseInt(c.req.query("max_depth") ?? "100", 10));
  const suggestedOnly = c.req.query("suggested_only") === "true";

  const rooms: SpaceHierarchyRoom[] = [];
  const visited = new Set<string>();

  const visit = async (
    currentRoomId: string,
    viaServers: string[],
    depth: number,
    forceVisible = false,
  ): Promise<void> => {
    if (visited.has(currentRoomId)) {
      return;
    }
    visited.add(currentRoomId);

    const snapshot = await loadHierarchySnapshot(c, currentRoomId, viaServers, suggestedOnly);
    if (!snapshot) {
      return;
    }

    const isVisible =
      forceVisible ||
      snapshot.room.world_readable ||
      (await queries.isRoomVisibleToUser(c.env.DB, currentRoomId, userId));
    if (!isVisible) {
      return;
    }

    rooms.push(snapshot.room);
    if (depth >= maxDepth) {
      return;
    }

    for (const edge of snapshot.childEdges) {
      await visit(edge.roomId, parseViaServers(edge.content), depth + 1);
    }
  };

  await visit(roomId, [c.env.SERVER_NAME], 0, true);

  const response: Record<string, unknown> = {
    rooms: rooms.slice(offset, offset + limit),
  };
  if (rooms.length > offset + limit) {
    response.next_batch = `offset_${offset + limit}`;
  }

  return c.json(response);
});

export default app;
