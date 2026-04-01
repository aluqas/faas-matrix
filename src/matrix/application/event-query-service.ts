import type { PDU } from "../../types";
import {
  getDefaultRoomVersion,
  getRedactionAllowedKeys,
  getRoomVersion,
} from "../../services/room-versions";

export type TimestampDirection = "f" | "b";

export interface MissingEventsQuery {
  roomId: string;
  earliestEvents: string[];
  latestEvents: string[];
  limit: number;
  minDepth: number;
  requestingServer?: string;
  roomVersion?: string;
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

type OrderedEvent = Pick<PDU, "event_id" | "origin_server_ts" | "depth">;

type HistoryVisibility = "world_readable" | "shared" | "invited" | "joined";

type HistoryVisibilityRow = {
  event_id: string;
  origin_server_ts: number;
  depth: number;
  content: string;
};

type MembershipRow = {
  event_id: string;
  origin_server_ts: number;
  depth: number;
  state_key: string;
  content: string;
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

type RoomMembershipSummaryRow = {
  membership: string;
};

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

function compareEventOrder(left: OrderedEvent, right: OrderedEvent): number {
  if (left.depth !== right.depth) {
    return left.depth - right.depth;
  }

  if (left.origin_server_ts !== right.origin_server_ts) {
    return left.origin_server_ts - right.origin_server_ts;
  }

  return left.event_id.localeCompare(right.event_id);
}

function getHistoryVisibilityValue(content: string): HistoryVisibility {
  const parsed = safeJsonParse<{ history_visibility?: unknown }>(content);
  switch (parsed?.history_visibility) {
    case "world_readable":
    case "shared":
    case "invited":
    case "joined":
      return parsed.history_visibility;
    default:
      return "shared";
  }
}

function getMembershipValue(content: string): string | null {
  const parsed = safeJsonParse<{ membership?: unknown }>(content);
  return typeof parsed?.membership === "string" ? parsed.membership : null;
}

function getHistoryVisibilityAtEvent(
  event: PDU,
  historyRows: HistoryVisibilityRow[],
): HistoryVisibility {
  let visibility: HistoryVisibility = "shared";

  for (const row of historyRows) {
    if (compareEventOrder(row, event) > 0) {
      break;
    }

    visibility = getHistoryVisibilityValue(row.content);
  }

  return visibility;
}

function getHistoryVisibilityBeforeEvent(
  event: PDU,
  historyRows: HistoryVisibilityRow[],
): { visibility: HistoryVisibility; hasPriorEvent: boolean } {
  let visibility: HistoryVisibility = "shared";
  let hasPriorEvent = false;

  for (const row of historyRows) {
    if (compareEventOrder(row, event) >= 0) {
      break;
    }

    hasPriorEvent = true;
    visibility = getHistoryVisibilityValue(row.content);
  }

  return { visibility, hasPriorEvent };
}

function isServerAllowedToSeeEventAtHistoryVisibility(
  event: PDU,
  requestingServer: string,
  historyRows: HistoryVisibilityRow[],
  membershipRows: MembershipRow[],
): boolean {
  const historyVisibility = getHistoryVisibilityAtEvent(event, historyRows);
  if (historyVisibility === "world_readable") {
    return true;
  }

  const relevantMembershipRows = membershipRows.filter((row) =>
    row.state_key.endsWith(`:${requestingServer}`),
  );
  const membershipBeforeEvent = new Map<string, string>();
  const joinedAfterEvent = new Set<string>();

  for (const row of relevantMembershipRows) {
    const membership = getMembershipValue(row.content);
    if (!membership) {
      continue;
    }

    if (compareEventOrder(row, event) <= 0) {
      membershipBeforeEvent.set(row.state_key, membership);
      continue;
    }

    if (membership === "join") {
      joinedAfterEvent.add(row.state_key);
    }
  }

  for (const [userId, membership] of membershipBeforeEvent) {
    if (membership === "join") {
      return true;
    }

    if (membership === "invite" && historyVisibility === "invited") {
      return true;
    }

    if (historyVisibility === "shared" && joinedAfterEvent.has(userId)) {
      return true;
    }
  }

  if (historyVisibility === "shared") {
    return joinedAfterEvent.size > 0;
  }

  return false;
}

function redactEventForMissingEvents(event: PDU, roomVersion: string): PDU {
  const roomVersionBehavior =
    getRoomVersion(roomVersion) ?? getRoomVersion(getDefaultRoomVersion());
  if (!roomVersionBehavior) {
    return event;
  }

  const allowedKeys = new Set(getRedactionAllowedKeys(event.type, roomVersionBehavior));
  const redactedContent = Object.fromEntries(
    Object.entries(event.content).filter(([key]) => allowedKeys.has(key)),
  );

  return {
    event_id: event.event_id,
    room_id: event.room_id,
    sender: event.sender,
    type: event.type,
    ...(event.state_key !== undefined ? { state_key: event.state_key } : {}),
    ...(event.origin !== undefined ? { origin: event.origin } : {}),
    ...(event.membership !== undefined ? { membership: event.membership } : {}),
    ...(event.prev_state !== undefined ? { prev_state: [...event.prev_state] } : {}),
    content: redactedContent,
    origin_server_ts: event.origin_server_ts,
    depth: event.depth,
    auth_events: [...event.auth_events],
    prev_events: [...event.prev_events],
    ...(event.hashes ? { hashes: { ...event.hashes } } : {}),
    ...(event.signatures
      ? {
          signatures: Object.fromEntries(
            Object.entries(event.signatures).map(([serverName, signatures]) => [
              serverName,
              { ...signatures },
            ]),
          ),
        }
      : {}),
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

    const sortedEvents = events.sort(compareEventOrder);

    if (!query.requestingServer) {
      return sortedEvents;
    }

    const roomVersion =
      query.roomVersion ??
      (
        await db
          .prepare(`SELECT room_version FROM rooms WHERE room_id = ?`)
          .bind(query.roomId)
          .first<{ room_version: string }>()
      )?.room_version ??
      getDefaultRoomVersion();

    const historyRows = await db
      .prepare(`
        SELECT event_id, origin_server_ts, depth, content
        FROM events
        WHERE room_id = ? AND event_type = 'm.room.history_visibility'
        ORDER BY depth ASC, origin_server_ts ASC, event_id ASC
      `)
      .bind(query.roomId)
      .all<HistoryVisibilityRow>();

    const membershipRows = await db
      .prepare(`
        SELECT event_id, origin_server_ts, depth, state_key, content
        FROM events
        WHERE room_id = ? AND event_type = 'm.room.member' AND state_key LIKE ?
        ORDER BY depth ASC, origin_server_ts ASC, event_id ASC
      `)
      .bind(query.roomId, `%:${query.requestingServer}`)
      .all<MembershipRow>();

    return sortedEvents.flatMap((event) => {
      if (event.type === "m.room.history_visibility" && event.state_key !== undefined) {
        const eventVisibility =
          typeof event.content.history_visibility === "string"
            ? event.content.history_visibility
            : "shared";
        const previousVisibility = getHistoryVisibilityBeforeEvent(event, historyRows.results);
        if (previousVisibility.hasPriorEvent && eventVisibility === previousVisibility.visibility) {
          return [];
        }
      }

      if (event.state_key !== undefined) {
        return [event];
      }

      if (
        isServerAllowedToSeeEventAtHistoryVisibility(
          event,
          query.requestingServer!,
          historyRows.results,
          membershipRows.results,
        )
      ) {
        return [event];
      }

      return [redactEventForMissingEvents(event, roomVersion)];
    });
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
      ORDER BY e.depth ASC, e.origin_server_ts ASC, e.event_id ASC
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

  async isRoomVisibleToUser(db: D1Database, roomId: string, userId: string): Promise<boolean> {
    const membership = await db
      .prepare(
        `
        SELECT membership
        FROM room_memberships
        WHERE room_id = ? AND user_id = ?
      `,
      )
      .bind(roomId, userId)
      .first<RoomMembershipSummaryRow>();

    if (
      membership?.membership === "join" ||
      membership?.membership === "invite" ||
      membership?.membership === "knock"
    ) {
      return true;
    }

    const roomInfo = await this.getRoomPublicInfo(db, roomId);
    return roomInfo?.world_readable === true;
  }
}
