import type { PDU } from "../../types";

export type TimestampDirection = "f" | "b";

export interface MissingEventsQuery {
  roomId: string;
  earliestEvents: string[];
  latestEvents: string[];
  limit: number;
  minDepth: number;
}

type EventRow = {
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
};

export interface PublicRoomInfo {
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
}

export interface SpaceChildEdge {
  roomId: string;
  content: Record<string, unknown>;
}

function safeJsonParse<T>(value: string | null | undefined): T | null {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function toPdu(row: EventRow): PDU {
  return {
    event_id: row.event_id,
    room_id: row.room_id,
    sender: row.sender,
    type: row.event_type,
    state_key: row.state_key ?? undefined,
    content: safeJsonParse<Record<string, unknown>>(row.content) ?? {},
    origin_server_ts: row.origin_server_ts,
    depth: row.depth,
    auth_events: safeJsonParse<string[]>(row.auth_events) ?? [],
    prev_events: safeJsonParse<string[]>(row.prev_events) ?? [],
    hashes: safeJsonParse<{ sha256: string }>(row.hashes ?? undefined) ?? undefined,
    signatures:
      safeJsonParse<Record<string, Record<string, string>>>(row.signatures ?? undefined) ??
      undefined,
  };
}

export function normalizeOffsetToken(from?: string | null): number {
  if (!from || !from.startsWith("offset_")) {
    return 0;
  }

  const parsed = Number.parseInt(from.slice("offset_".length), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function selectSpaceChildren(
  edges: SpaceChildEdge[],
  options: { suggestedOnly: boolean; limit: number; offset: number },
): { children: SpaceChildEdge[]; hasMore: boolean } {
  const filtered = edges.filter((edge) => {
    const via = edge.content.via;
    if (!Array.isArray(via) || via.length === 0) {
      return false;
    }

    if (options.suggestedOnly && edge.content.suggested !== true) {
      return false;
    }

    return true;
  });

  return {
    children: filtered.slice(options.offset, options.offset + options.limit),
    hasMore: filtered.length > options.offset + options.limit,
  };
}

export class EventQueryService {
  async roomExists(db: D1Database, roomId: string): Promise<boolean> {
    const room = await db
      .prepare(`
      SELECT room_id
      FROM rooms
      WHERE room_id = ?
    `)
      .bind(roomId)
      .first<{ room_id: string }>();

    return !!room;
  }

  async getMissingEvents(db: D1Database, query: MissingEventsQuery): Promise<PDU[]> {
    // BFS backwards from latest_events through prev_events.
    // latest_events are the starting points — walk from here but exclude from results.
    // earliest_events are the stop boundary — exclude from results and don't walk past them.
    const frontier = [...query.latestEvents];
    const startSet = new Set(query.latestEvents);
    const stopSet = new Set(query.earliestEvents);
    const visited = new Set<string>();
    const events: PDU[] = [];

    while (frontier.length > 0 && events.length < query.limit) {
      const eventId = frontier.shift()!;
      if (visited.has(eventId)) {
        continue;
      }
      visited.add(eventId);

      const row = await db
        .prepare(`
        SELECT event_id, room_id, sender, event_type, state_key, content,
               origin_server_ts, depth, auth_events, prev_events, hashes, signatures
        FROM events
        WHERE event_id = ? AND room_id = ? AND depth >= ?
      `)
        .bind(eventId, query.roomId, query.minDepth)
        .first<EventRow>();

      if (!row) {
        continue;
      }

      const event = toPdu(row);

      // Exclude start points (latest_events) and stop points (earliest_events) from results
      if (!startSet.has(event.event_id) && !stopSet.has(event.event_id)) {
        events.push(event);
      }

      // Walk prev_events, stopping at earliest_events boundary
      for (const prevId of event.prev_events ?? []) {
        if (!visited.has(prevId) && !stopSet.has(prevId)) {
          frontier.push(prevId);
        }
      }
    }

    return events;
  }

  async findClosestEventByTimestamp(
    db: D1Database,
    roomId: string,
    ts: number,
    dir: TimestampDirection,
  ): Promise<{ event_id: string; origin_server_ts: number } | null> {
    if (dir === "b") {
      return db
        .prepare(`
        SELECT event_id, origin_server_ts
        FROM events
        WHERE room_id = ? AND origin_server_ts <= ?
        ORDER BY origin_server_ts DESC
        LIMIT 1
      `)
        .bind(roomId, ts)
        .first<{ event_id: string; origin_server_ts: number }>();
    }

    return db
      .prepare(`
      SELECT event_id, origin_server_ts
      FROM events
      WHERE room_id = ? AND origin_server_ts >= ?
      ORDER BY origin_server_ts ASC
      LIMIT 1
    `)
      .bind(roomId, ts)
      .first<{ event_id: string; origin_server_ts: number }>();
  }

  async getSpaceChildEdges(db: D1Database, roomId: string): Promise<SpaceChildEdge[]> {
    const rows = await db
      .prepare(`
      SELECT rs.state_key, e.content
      FROM room_state rs
      JOIN events e ON rs.event_id = e.event_id
      WHERE rs.room_id = ? AND rs.event_type = 'm.space.child' AND e.redacted_because IS NULL
    `)
      .bind(roomId)
      .all<{ state_key: string; content: string }>();

    return rows.results.flatMap((row) => {
      const content = safeJsonParse<Record<string, unknown>>(row.content);
      if (!content) {
        return [];
      }

      return [
        {
          roomId: row.state_key,
          content,
        },
      ];
    });
  }

  async getRoomPublicInfo(db: D1Database, roomId: string): Promise<PublicRoomInfo | null> {
    const room = await db
      .prepare(`
      SELECT room_id
      FROM rooms
      WHERE room_id = ?
    `)
      .bind(roomId)
      .first<{ room_id: string }>();

    if (!room) {
      return null;
    }

    const stateRows = await db
      .prepare(`
      SELECT rs.event_type, e.content
      FROM room_state rs
      JOIN events e ON rs.event_id = e.event_id
      WHERE rs.room_id = ?
        AND rs.event_type IN (
          'm.room.name',
          'm.room.topic',
          'm.room.canonical_alias',
          'm.room.avatar',
          'm.room.join_rules',
          'm.room.history_visibility',
          'm.room.guest_access',
          'm.room.create'
        )
    `)
      .bind(roomId)
      .all<{ event_type: string; content: string }>();

    const state = new Map<string, Record<string, unknown>>();
    for (const row of stateRows.results) {
      const content = safeJsonParse<Record<string, unknown>>(row.content);
      if (content) {
        state.set(row.event_type, content);
      }
    }

    const memberCount = await db
      .prepare(`
      SELECT COUNT(*) as count
      FROM room_memberships
      WHERE room_id = ? AND membership = 'join'
    `)
      .bind(roomId)
      .first<{ count: number }>();

    const historyVisibility = state.get("m.room.history_visibility")?.history_visibility;
    const guestAccess = state.get("m.room.guest_access")?.guest_access;

    return {
      room_id: roomId,
      room_type:
        typeof state.get("m.room.create")?.type === "string"
          ? (state.get("m.room.create")?.type as string)
          : undefined,
      name:
        typeof state.get("m.room.name")?.name === "string"
          ? (state.get("m.room.name")?.name as string)
          : undefined,
      topic:
        typeof state.get("m.room.topic")?.topic === "string"
          ? (state.get("m.room.topic")?.topic as string)
          : undefined,
      canonical_alias:
        typeof state.get("m.room.canonical_alias")?.alias === "string"
          ? (state.get("m.room.canonical_alias")?.alias as string)
          : undefined,
      avatar_url:
        typeof state.get("m.room.avatar")?.url === "string"
          ? (state.get("m.room.avatar")?.url as string)
          : undefined,
      join_rule:
        typeof state.get("m.room.join_rules")?.join_rule === "string"
          ? (state.get("m.room.join_rules")?.join_rule as string)
          : "invite",
      num_joined_members: memberCount?.count ?? 0,
      world_readable: historyVisibility === "world_readable",
      guest_can_join: guestAccess === "can_join",
    };
  }
}
