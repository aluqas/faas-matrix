// Sliding Sync API (MSC3575 & MSC4186)
// Implements both the original sliding sync and simplified sliding sync

import { Effect } from "effect";
import { Hono, type Context } from "hono";
import type { AppEnv, EventId, RoomId, UserId } from "../shared/types";
import type {
  RoomResult,
  SlidingRoomFilter,
  SlidingSyncRequest,
  SlidingSyncResponse,
} from "../shared/types/sync";
import { Errors } from "../shared/utils/errors";
import { requireAuth } from "../infra/middleware/auth";
import { runClientEffect } from "../matrix/application/runtime/effect-runtime";
import { getTypingForRooms } from "../features/typing/project";
import { getReceiptsForRooms } from "../features/receipts/project";
import { countNotificationsWithRules } from "../infra/realtime/push-rule-evaluator";
import type { ConnectionState } from "../features/sync/effect-ports";
import {
  didSlidingSyncListChange,
  firstTimeRead,
  readMarkerChanged,
  shouldIncludeSlidingSyncRoom,
  trackSlidingSyncRoomReadState,
} from "../features/sync/sliding-sync-shared";
import { buildSlidingSyncVisibilityContext } from "../features/sync/contracts";
import {
  getEffectiveJoinedMemberCount,
  getJoinedRoomIdsIncludingPartialState,
} from "../infra/repositories/membership-repository";
import {
  buildSlidingSyncExtensions,
  type SlidingSyncExtensionConfig,
} from "./sliding-sync-extensions";
import { toEventId, toRoomId, toUserId } from "../shared/utils/ids";

const app = new Hono<AppEnv>();

// Types for sliding sync

async function loadSlidingSyncVisibilityContext(
  db: D1Database,
  userId: UserId,
): Promise<ReturnType<typeof buildSlidingSyncVisibilityContext>> {
  const ids = await getJoinedRoomIdsIncludingPartialState(db, userId);
  return buildSlidingSyncVisibilityContext(ids);
}

// Helper to get the current maximum stream ordering from the database
async function getCurrentStreamPosition(db: D1Database): Promise<number> {
  const result = await db
    .prepare(`SELECT MAX(stream_ordering) as max_pos FROM events`)
    .first<{ max_pos: number | null }>();
  return result?.max_pos ?? 0;
}

async function loadConnectionState(
  syncDO: DurableObjectNamespace,
  userId: UserId,
  connId: string,
): Promise<ConnectionState | null> {
  const doId = syncDO.idFromName(userId);
  const stub = syncDO.get(doId);

  try {
    const response = await stub.fetch(
      new URL(`http://internal/sliding-sync/state?conn_id=${encodeURIComponent(connId)}`),
      { method: "GET" },
    );

    if (!response.ok) {
      const errorText = await response.text().catch(() => "unknown error");
      throw new Error(`DO fetch failed: ${response.status} - ${errorText}`);
    }

    return await response.json();
  } catch (error) {
    console.error("[sliding-sync] Failed to get connection state from DO:", error);
    throw error;
  }
}

async function persistConnectionState(
  syncDO: DurableObjectNamespace,
  userId: UserId,
  connId: string,
  state: ConnectionState,
): Promise<void> {
  const doId = syncDO.idFromName(userId);
  const stub = syncDO.get(doId);

  try {
    const response = await stub.fetch(
      new URL(`http://internal/sliding-sync/state?conn_id=${encodeURIComponent(connId)}`),
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(state),
      },
    );

    if (!response.ok) {
      const errorText = await response.text().catch(() => "unknown error");
      throw new Error(`DO save failed: ${response.status} - ${errorText}`);
    }
  } catch (error) {
    console.error("[sliding-sync] Failed to save connection state to DO:", error);
  }
}

async function waitForSlidingSyncEvents(
  syncDO: DurableObjectNamespace,
  userId: UserId,
  timeoutMs: number,
): Promise<{ hasEvents: boolean }> {
  const doId = syncDO.idFromName(userId);
  const stub = syncDO.get(doId);
  const response = await stub.fetch(
    new Request("http://internal/wait-for-events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timeout: timeoutMs }),
    }),
  );
  return response.json();
}

async function getFullyReadMarker(
  db: D1Database,
  userId: UserId,
  roomId: RoomId,
): Promise<EventId | null> {
  const fullyReadResult = await db
    .prepare(`
      SELECT content FROM account_data
      WHERE user_id = ? AND room_id = ? AND event_type = 'm.fully_read'
    `)
    .bind(userId, roomId)
    .first<{ content: string }>();

  if (!fullyReadResult) {
    return null;
  }

  try {
    return toEventId(JSON.parse(fullyReadResult.content).event_id);
  } catch {
    return null;
  }
}

// Get rooms for a user with optional filtering
// OPTIMIZED: Uses consolidated query with subqueries to avoid N+1 problem
async function getUserRooms(
  db: D1Database,
  userId: UserId,
  filters?: SlidingRoomFilter,
  sort?: string[],
): Promise<
  { roomId: RoomId; membership: string; lastActivity: number; name?: string; isDm: boolean }[]
> {
  // Consolidated query with subqueries for room name and member count
  // This eliminates N+1 queries by fetching all data in a single query
  let query = `
    SELECT
      rm.room_id,
      rm.membership,
      COALESCE(
        (SELECT MAX(origin_server_ts) FROM events WHERE room_id = rm.room_id),
        r.created_at
      ) as last_activity,
      -- Subquery for room name (JSON_EXTRACT is SQLite function)
      (SELECT JSON_EXTRACT(e.content, '$.name')
       FROM room_state rs
       JOIN events e ON rs.event_id = e.event_id
       WHERE rs.room_id = rm.room_id AND rs.event_type = 'm.room.name'
       LIMIT 1
      ) as room_name,
      -- Subquery for member count (for DM detection)
      (SELECT COUNT(*)
       FROM room_memberships rm2
       WHERE rm2.room_id = rm.room_id AND rm2.membership = 'join'
      ) as member_count
    FROM room_memberships rm
    JOIN rooms r ON rm.room_id = r.room_id
    WHERE rm.user_id = ?
  `;
  const params: any[] = [userId];

  // Apply filters
  if (filters?.is_invite) {
    query += ` AND rm.membership = 'invite'`;
  } else if (filters?.is_tombstoned) {
    // Check for tombstone state
    query += ` AND EXISTS (SELECT 1 FROM room_state rs JOIN events e ON rs.event_id = e.event_id WHERE rs.room_id = rm.room_id AND rs.event_type = 'm.room.tombstone')`;
  } else {
    // By default, only return rooms the user has joined or been invited to
    query += ` AND rm.membership IN ('join', 'invite')`;
  }

  // Default sort: by recency
  const sortBy = sort ?? ["by_recency"];
  if (sortBy.includes("by_recency")) {
    query += ` ORDER BY last_activity DESC`;
  } else if (sortBy.includes("by_name")) {
    query += ` ORDER BY COALESCE(room_name, rm.room_id) ASC`;
  } else {
    query += ` ORDER BY last_activity DESC`;
  }

  const result = await db
    .prepare(query)
    .bind(...params)
    .all();

  const rooms: {
    roomId: RoomId;
    membership: string;
    lastActivity: number;
    name?: string;
    isDm: boolean;
  }[] = [];

  for (const row of result.results as any[]) {
    const roomId = toRoomId(row.room_id);
    if (!roomId) {
      continue;
    }
    const name = row.room_name as string | null | undefined;
    const memberCount = row.member_count as number;

    // A DM is typically a room with 2 members and no explicit name
    const isDm = memberCount <= 2 && !name;

    // Apply filters in memory (already have all data)
    if (filters?.room_name_like && name) {
      if (!name.toLowerCase().includes(filters.room_name_like.toLowerCase())) {
        continue;
      }
    }

    if (filters?.is_dm !== undefined) {
      if (filters.is_dm && !isDm) continue;
      if (!filters.is_dm && isDm) continue;
    }

    rooms.push({
      roomId,
      membership: row.membership,
      lastActivity: row.last_activity,
      name: name ?? undefined,
      isDm,
    });
  }

  return rooms;
}

function toRoomIds(values: string[]): RoomId[] {
  return values.map((value) => toRoomId(value)).filter((value): value is RoomId => value !== null);
}

function toRoomEntries<T>(value: Record<RoomId, T>): Array<[RoomId, T]> {
  return Object.entries(value)
    .map(([roomId, entry]) => {
      const typedRoomId = toRoomId(roomId);
      return typedRoomId ? ([typedRoomId, entry] as const) : null;
    })
    .filter((entry): entry is readonly [RoomId, T] => entry !== null)
    .map(([roomId, entry]) => [roomId, entry] as [RoomId, T]);
}

// Get room data for response
// OPTIMIZED: Uses DB.batch() to fetch all room metadata in a single network call
async function getRoomData(
  db: D1Database,
  roomId: RoomId,
  userId: UserId,
  config: {
    requiredState?: [string, string][];
    timelineLimit?: number;
    initial?: boolean;
    sinceStreamOrdering?: number; // Only return events after this stream position
  },
): Promise<RoomResult & { maxStreamOrdering?: number }> {
  const result: RoomResult & { maxStreamOrdering?: number } = {
    membership: "join", // MSC4186: explicitly indicate this is a joined room
  };

  // OPTIMIZATION: Batch all metadata queries into a single network call
  // This reduces 8+ sequential queries to 1 batched call
  const [
    roomResult,
    nameResult,
    avatarResult,
    topicResult,
    aliasResult,
    invitedCountResult,
    heroesResult,
  ] = await db.batch([
    // 1. Room info
    db.prepare(`SELECT room_id, created_at FROM rooms WHERE room_id = ?`).bind(roomId),
    // 2. Room name
    db
      .prepare(`
      SELECT e.content FROM room_state rs
      JOIN events e ON rs.event_id = e.event_id
      WHERE rs.room_id = ? AND rs.event_type = 'm.room.name'
    `)
      .bind(roomId),
    // 3. Room avatar
    db
      .prepare(`
      SELECT e.content FROM room_state rs
      JOIN events e ON rs.event_id = e.event_id
      WHERE rs.room_id = ? AND rs.event_type = 'm.room.avatar'
    `)
      .bind(roomId),
    // 4. Room topic
    db
      .prepare(`
      SELECT e.content FROM room_state rs
      JOIN events e ON rs.event_id = e.event_id
      WHERE rs.room_id = ? AND rs.event_type = 'm.room.topic'
    `)
      .bind(roomId),
    // 5. Canonical alias
    db
      .prepare(`
      SELECT e.content FROM room_state rs
      JOIN events e ON rs.event_id = e.event_id
      WHERE rs.room_id = ? AND rs.event_type = 'm.room.canonical_alias'
    `)
      .bind(roomId),
    // 6. Invited member count
    db
      .prepare(
        `SELECT COUNT(*) as count FROM room_memberships WHERE room_id = ? AND membership = 'invite'`,
      )
      .bind(roomId),
    // 7. Heroes (other members for display)
    db
      .prepare(`
      SELECT user_id, display_name, avatar_url
      FROM room_memberships
      WHERE room_id = ? AND membership = 'join' AND user_id != ?
      LIMIT 5
    `)
      .bind(roomId, userId),
  ]);

  // Check if room exists
  const room = roomResult.results[0] as { room_id: string; created_at: number } | undefined;
  if (!room) {
    return result;
  }

  // Process batched results
  result.initial = config.initial;

  const joinedCount = await getEffectiveJoinedMemberCount(db, roomId);
  const invitedCount = (invitedCountResult.results[0] as { count: number } | undefined)?.count ?? 0;
  result.joined_count = joinedCount;
  result.invited_count = invitedCount;
  result.is_dm = joinedCount <= 2;

  // Room name
  const nameEvent = nameResult.results[0] as { content: string } | undefined;
  if (nameEvent) {
    try {
      result.name = JSON.parse(nameEvent.content).name;
    } catch {
      /* ignore */
    }
  }

  // Room avatar
  const avatarEvent = avatarResult.results[0] as { content: string } | undefined;
  if (avatarEvent) {
    try {
      result.avatar = JSON.parse(avatarEvent.content).url;
    } catch {
      /* ignore */
    }
  }

  // Room topic
  const topicEvent = topicResult.results[0] as { content: string } | undefined;
  if (topicEvent) {
    try {
      result.topic = JSON.parse(topicEvent.content).topic;
    } catch {
      /* ignore */
    }
  }

  // Canonical alias
  const aliasEvent = aliasResult.results[0] as { content: string } | undefined;
  if (aliasEvent) {
    try {
      result.canonical_alias = JSON.parse(aliasEvent.content).alias;
    } catch {
      /* ignore */
    }
  }

  // Heroes (only used when room has no name)
  if (!result.name) {
    result.heroes = (heroesResult.results as any[]).map((h) => ({
      user_id: h.user_id,
      displayname: h.display_name,
      avatar_url: h.avatar_url,
    }));
  }

  // Get required state
  if (config.requiredState && config.requiredState.length > 0) {
    result.required_state = [];

    for (const [eventType, stateKey] of config.requiredState) {
      let stateQuery = `
        SELECT e.event_id, e.event_type, e.state_key, e.content, e.sender, e.origin_server_ts, e.unsigned
        FROM room_state rs
        JOIN events e ON rs.event_id = e.event_id
        WHERE rs.room_id = ?
      `;
      const stateParams: any[] = [roomId];

      if (eventType !== "*") {
        stateQuery += ` AND rs.event_type = ?`;
        stateParams.push(eventType);
      }

      if (stateKey !== "*" && stateKey !== "") {
        stateQuery += ` AND rs.state_key = ?`;
        // Handle $ME placeholder - replace with actual user ID
        const resolvedStateKey = stateKey === "$ME" ? userId : stateKey;
        stateParams.push(resolvedStateKey);
      } else if (stateKey === "") {
        stateQuery += ` AND rs.state_key = ''`;
      }

      const stateEvents = await db
        .prepare(stateQuery)
        .bind(...stateParams)
        .all();

      for (const event of stateEvents.results as any[]) {
        try {
          result.required_state.push({
            type: event.event_type,
            state_key: event.state_key,
            content: JSON.parse(event.content),
            sender: event.sender,
            origin_server_ts: event.origin_server_ts,
            event_id: event.event_id,
            room_id: roomId,
            unsigned: event.unsigned ? JSON.parse(event.unsigned) : undefined,
          });
        } catch {
          /* ignore parse errors */
        }
      }
    }
  }

  // Get timeline
  if (config.timelineLimit && config.timelineLimit > 0) {
    let timelineQuery: string;
    let timelineParams: (string | number)[];
    const isIncremental =
      config.sinceStreamOrdering !== undefined && config.sinceStreamOrdering > 0;

    // For incremental sync (sinceStreamOrdering provided), only get new events
    // For initial sync, get the last N events
    // Fetch one extra event to determine if there are more events than the limit
    const fetchLimit = config.timelineLimit + 1;

    if (isIncremental) {
      // Incremental: get events since the last sync position
      timelineQuery = `
        SELECT event_id, event_type, state_key, content, sender, origin_server_ts, unsigned, depth, stream_ordering
        FROM events
        WHERE room_id = ? AND stream_ordering > ?
        ORDER BY stream_ordering ASC
        LIMIT ?
      `;
      timelineParams = [roomId, config.sinceStreamOrdering!, fetchLimit];
    } else {
      // Initial: get the most recent events
      timelineQuery = `
        SELECT event_id, event_type, state_key, content, sender, origin_server_ts, unsigned, depth, stream_ordering
        FROM events
        WHERE room_id = ?
        ORDER BY stream_ordering DESC
        LIMIT ?
      `;
      timelineParams = [roomId, fetchLimit];
    }

    const timelineEvents = await db
      .prepare(timelineQuery)
      .bind(...timelineParams)
      .all();

    // Check if there are more events than the limit
    const hasMoreEvents = timelineEvents.results.length > config.timelineLimit;

    // Only use up to timelineLimit events
    const eventsToUse = timelineEvents.results.slice(0, config.timelineLimit) as any[];

    // For initial sync, reverse to get chronological order
    const eventsToProcess = isIncremental ? eventsToUse : eventsToUse.toReversed();

    result.timeline = eventsToProcess.map((event) => {
      try {
        return {
          type: event.event_type,
          event_id: event.event_id,
          room_id: roomId,
          sender: event.sender,
          origin_server_ts: event.origin_server_ts,
          content: JSON.parse(event.content),
          state_key: event.state_key ?? undefined,
          unsigned: event.unsigned ? JSON.parse(event.unsigned) : undefined,
        };
      } catch {
        return {
          type: event.event_type,
          event_id: event.event_id,
          room_id: roomId,
          sender: event.sender,
          origin_server_ts: event.origin_server_ts,
          content: {},
          state_key: event.state_key ?? undefined,
        };
      }
    });

    // Track the max stream_ordering we're sending
    if (eventsToProcess.length > 0) {
      const maxEvent = eventsToProcess.at(-1);
      result.maxStreamOrdering = maxEvent.stream_ordering;
    }

    // Set num_live for incremental syncs (tells client how many new events)
    if (isIncremental) {
      result.num_live = eventsToProcess.length;
    }

    // Get prev_batch for pagination (only useful for initial sync really)
    if (eventsToProcess.length > 0) {
      const oldestEvent = eventsToProcess[0];
      result.prev_batch = `s${oldestEvent.stream_ordering ?? oldestEvent.depth}`;
    }

    // limited: true means there are more events than what was returned
    // For incremental syncs: only true if there are actually more new events
    // For initial syncs: true if there are more historical events
    result.limited = hasMoreEvents;
  }

  // Get notification and highlight counts using push rule evaluation
  const counts = await countNotificationsWithRules(db, userId, roomId);
  result.notification_count = counts.notification_count;
  result.highlight_count = counts.highlight_count;

  // Get last activity timestamp
  const lastEvent = await db
    .prepare(`
    SELECT MAX(origin_server_ts) as ts FROM events WHERE room_id = ?
  `)
    .bind(roomId)
    .first<{ ts: number }>();

  if (lastEvent?.ts) {
    result.bump_stamp = lastEvent.ts;
    result.timestamp = lastEvent.ts;
  }

  return result;
}

// Get stripped invite state for invited rooms
// Per Matrix spec, invited rooms only see limited "stripped state"
async function getInviteRoomData(
  db: D1Database,
  roomId: RoomId,
  userId: UserId,
): Promise<RoomResult> {
  const result: RoomResult = {
    initial: true,
    membership: "invite", // MSC4186: explicitly indicate this is an invited room
  };

  // Get stripped state events for invited users
  // These are the key events that help the user understand what they're invited to
  const strippedStateTypes = [
    "m.room.create",
    "m.room.name",
    "m.room.avatar",
    "m.room.topic",
    "m.room.canonical_alias",
    "m.room.encryption",
    "m.room.member", // Only for inviter and invitee
  ];

  const inviteState: any[] = [];

  for (const eventType of strippedStateTypes) {
    let query = `
      SELECT e.event_type, e.state_key, e.content, e.sender
      FROM room_state rs
      JOIN events e ON rs.event_id = e.event_id
      WHERE rs.room_id = ? AND rs.event_type = ?
    `;
    const params: any[] = [roomId, eventType];

    // For member events, only include the invitee's own membership
    if (eventType === "m.room.member") {
      query += ` AND rs.state_key = ?`;
      params.push(userId);
    }

    const events = await db
      .prepare(query)
      .bind(...params)
      .all();

    for (const event of events.results as any[]) {
      try {
        inviteState.push({
          type: event.event_type,
          state_key: event.state_key,
          content: JSON.parse(event.content),
          sender: event.sender,
        });
      } catch {
        /* ignore parse errors */
      }
    }
  }

  result.invite_state = inviteState;

  // Extract name from state if available
  const nameEvent = inviteState.find((e) => e.type === "m.room.name");
  if (nameEvent?.content?.name) {
    result.name = nameEvent.content.name;
  }

  // Extract avatar from state if available
  const avatarEvent = inviteState.find((e) => e.type === "m.room.avatar");
  if (avatarEvent?.content?.url) {
    result.avatar = avatarEvent.content.url;
  }

  const joinedCount = await getEffectiveJoinedMemberCount(db, roomId);

  const invitedCount = await db
    .prepare(`
    SELECT COUNT(*) as count FROM room_memberships WHERE room_id = ? AND membership = 'invite'
  `)
    .bind(roomId)
    .first<{ count: number }>();

  result.joined_count = joinedCount;
  result.invited_count = invitedCount?.count ?? 0;

  return result;
}

async function buildMsc3575SlidingSyncResponse(
  c: Context<AppEnv>,
  body: SlidingSyncRequest,
): Promise<SlidingSyncResponse | Response> {
  const userId = toUserId(c.get("userId"));
  if (!userId) {
    return Errors.invalidParam("userId", "Invalid user ID").toResponse();
  }
  const db = c.env.DB;
  const syncDO = c.env.SYNC; // Use Durable Object for connection state (not KV - avoids rate limits)

  const connId = body.conn_id ?? "default";
  // Note: timeout is parsed but not used yet (for future long-polling support)
  const _ = Math.min(body.timeout ?? 0, 30000);
  void _;

  // Get current stream position from database
  const currentStreamPos = await getCurrentStreamPosition(db);

  // Get or create connection state
  let connectionState: ConnectionState | null;
  try {
    connectionState = await loadConnectionState(syncDO, userId, connId);
  } catch (error) {
    // DO unavailable - return error so client knows to retry
    console.error("[sliding-sync MSC3575] DO unavailable:", error);
    return c.json(
      {
        errcode: "M_UNKNOWN",
        error: "Sync service temporarily unavailable",
      },
      503,
    );
  }

  // IMPORTANT: pos can be in query string OR body - check both
  const queryPos = c.req.query("pos");
  const posToken = queryPos ?? body.pos;
  const sincePos = posToken ? parseInt(posToken, 10) : 0;
  // Note: isInitialSync is computed but not currently used (for future diagnostics)
  void (!posToken || !connectionState);

  // If client sends a pos but we don't have connection state, check if the pos
  // is a valid stream position (could be from before a deployment or KV expiry)
  if (posToken && !connectionState) {
    if (sincePos <= currentStreamPos) {
      // Valid position, create fresh connection state treating it as a reconnect
      console.log(
        "[sliding-sync MSC3575] Reconnecting with valid pos",
        sincePos,
        "current:",
        currentStreamPos,
      );
      connectionState = {
        userId,
        pos: sincePos,
        lastAccess: Date.now(),
        roomStates: {},
        listStates: {},
      };
    } else {
      // Position is in the future - invalid
      return c.json(
        {
          errcode: "M_UNKNOWN_POS",
          error: "Unknown position token",
        },
        400,
      );
    }
  }

  connectionState ??= {
    userId,
    pos: 0,
    lastAccess: Date.now(),
    roomStates: {},
    listStates: {},
  };

  connectionState.pos = currentStreamPos;
  connectionState.lastAccess = Date.now();

  const response: SlidingSyncResponse = {
    pos: String(currentStreamPos),
    lists: {},
    rooms: {},
    extensions: {},
  };

  if (body.txn_id) {
    response.txn_id = body.txn_id;
  }

  // Process lists
  if (body.lists) {
    for (const [listKey, listConfig] of Object.entries(body.lists)) {
      const rooms = await getUserRooms(db, userId, listConfig.filters, listConfig.sort);

      // Determine range to return
      let startIndex = 0;
      let endIndex = rooms.length - 1;

      // MSC3575 uses ranges array
      if (listConfig.ranges && listConfig.ranges.length > 0) {
        startIndex = listConfig.ranges[0][0];
        endIndex = Math.min(listConfig.ranges[0][1], rooms.length - 1);
      }
      // MSC4186 uses single range
      else if (listConfig.range) {
        startIndex = listConfig.range[0];
        endIndex = Math.min(listConfig.range[1], rooms.length - 1);
      }

      const roomsInRange = rooms.slice(startIndex, endIndex + 1);
      const roomIds = roomsInRange.map((r) => r.roomId);

      // Check if the list has changed since last sync
      const previousListState = connectionState.listStates[listKey];
      const listChanged = didSlidingSyncListChange(previousListState, roomIds, rooms.length);

      // Only include ops if the list changed (or it's an initial sync)
      if (listChanged) {
        response.lists[listKey] = {
          count: rooms.length,
          ops: [
            {
              op: "SYNC",
              range: [startIndex, endIndex],
              room_ids: roomIds,
            },
          ],
        };
      } else {
        // List unchanged - just report count with no ops
        response.lists[listKey] = {
          count: rooms.length,
        };
      }

      // Get room data for rooms in range
      for (const roomInfo of roomsInRange) {
        const roomState = connectionState.roomStates[roomInfo.roomId];
        const isInitialRoom = !roomState?.sentState;
        const roomSincePos = isInitialRoom ? 0 : (roomState?.lastStreamOrdering ?? 0);

        // Handle invited rooms differently - they get invite_state not timeline
        // Always include invited room data (small payload) so client doesn't lose invites on reconnect
        if (roomInfo.membership === "invite") {
          const roomData = await getInviteRoomData(db, roomInfo.roomId, userId);
          response.rooms[roomInfo.roomId] = roomData;
          connectionState.roomStates[roomInfo.roomId] = {
            sentState: true,
            lastStreamOrdering: roomSincePos,
          };
          continue;
        }

        // For joined rooms, get full room data
        const roomData = await getRoomData(db, roomInfo.roomId, userId, {
          requiredState: listConfig.required_state,
          timelineLimit: listConfig.timeline_limit ?? 10,
          initial: isInitialRoom,
          sinceStreamOrdering: isInitialRoom ? undefined : roomSincePos,
        });

        // Check if notification count changed (for marking rooms as read)
        const hasPrevCount = roomInfo.roomId in (connectionState.roomNotificationCounts ?? {});
        const prevNotificationCount =
          connectionState.roomNotificationCounts?.[roomInfo.roomId] ?? 0;
        const currentNotificationCount = roomData.notification_count ?? 0;
        const notificationCountChanged =
          hasPrevCount && currentNotificationCount !== prevNotificationCount;

        // Check if m.fully_read marker changed
        const currentFullyRead = await getFullyReadMarker(db, userId, roomInfo.roomId);
        const fullyReadChanged = readMarkerChanged(
          connectionState.roomFullyReadMarkers?.[roomInfo.roomId],
          currentFullyRead,
        );

        // Track if this is the first time we're sending this room as "read" (notification_count = 0)
        // This ensures Element X receives the room with 0 unread count at least once
        const shouldMarkFirstRead = firstTimeRead(
          connectionState,
          roomInfo.roomId,
          currentNotificationCount,
        );

        // Include room if it's initial, has new events, notification count changed, fully_read changed, OR first time read
        if (
          shouldIncludeSlidingSyncRoom({
            isInitialRoom,
            timelineEventCount: roomData.timeline?.length ?? 0,
            notificationCountChanged,
            fullyReadChanged,
            firstTimeRead: shouldMarkFirstRead,
          })
        ) {
          response.rooms[roomInfo.roomId] = roomData;
          if (currentFullyRead) {
            trackSlidingSyncRoomReadState(
              connectionState,
              roomInfo.roomId,
              currentNotificationCount,
              currentFullyRead,
            );
          }
        }

        // Mark as sent with stream ordering tracking
        const newStreamOrdering = roomData.maxStreamOrdering ?? roomSincePos;
        connectionState.roomStates[roomInfo.roomId] = {
          sentState: true,
          lastStreamOrdering: newStreamOrdering,
        };
      }

      // Save list state
      connectionState.listStates[listKey] = {
        roomIds,
        count: rooms.length,
      };
    }
  }

  // Process room subscriptions
  if (body.room_subscriptions) {
    for (const [roomId, subscription] of toRoomEntries(
      body.room_subscriptions as Record<RoomId, unknown>,
    )) {
      const subscriptionConfig = subscription as {
        required_state?: [string, string][];
        timeline_limit?: number;
      };
      // Check if user has access to this room
      const membershipResult = await db
        .prepare(`
        SELECT membership FROM room_memberships WHERE room_id = ? AND user_id = ?
      `)
        .bind(roomId, userId)
        .first<{ membership: string }>();

      if (!membershipResult) {
        continue; // Skip rooms user isn't in
      }

      const roomState = connectionState.roomStates[roomId];
      const isInitialRoom = !roomState?.sentState;
      const roomSincePos = isInitialRoom ? 0 : (roomState?.lastStreamOrdering ?? 0);

      // Handle invited rooms differently - they get invite_state not timeline
      // Always include invited room data (small payload) so client doesn't lose invites on reconnect
      if (membershipResult.membership === "invite") {
        const roomData = await getInviteRoomData(db, roomId, userId);
        response.rooms[roomId] = roomData;
        connectionState.roomStates[roomId] = {
          sentState: true,
          lastStreamOrdering: roomSincePos,
        };
        continue;
      }

      // For joined rooms, get full room data
      const roomData = await getRoomData(db, roomId, userId, {
        requiredState: subscriptionConfig.required_state,
        timelineLimit: subscriptionConfig.timeline_limit ?? 10,
        initial: isInitialRoom,
        sinceStreamOrdering: isInitialRoom ? undefined : roomSincePos,
      });

      // Check if notification count changed (for marking rooms as read)
      const hasPrevCount = roomId in (connectionState.roomNotificationCounts ?? {});
      const prevNotificationCount = connectionState.roomNotificationCounts?.[roomId] ?? 0;
      const currentNotificationCount = roomData.notification_count ?? 0;
      const notificationCountChanged =
        hasPrevCount && currentNotificationCount !== prevNotificationCount;

      // Check if m.fully_read marker changed
      const currentFullyRead = await getFullyReadMarker(db, userId, roomId);
      const fullyReadChanged = readMarkerChanged(
        connectionState.roomFullyReadMarkers?.[roomId],
        currentFullyRead,
      );

      // Track if this is the first time we're sending this room as "read" (notification_count = 0)
      const shouldMarkFirstRead = firstTimeRead(connectionState, roomId, currentNotificationCount);

      // Include room if it's initial, has new events, notification count changed, fully_read changed, OR first time read
      if (
        shouldIncludeSlidingSyncRoom({
          isInitialRoom,
          timelineEventCount: roomData.timeline?.length ?? 0,
          notificationCountChanged,
          fullyReadChanged,
          firstTimeRead: shouldMarkFirstRead,
        })
      ) {
        response.rooms[roomId] = roomData;
        if (currentFullyRead) {
          trackSlidingSyncRoomReadState(
            connectionState,
            roomId,
            currentNotificationCount,
            currentFullyRead,
          );
        }
      }

      const newStreamOrdering = roomData.maxStreamOrdering ?? roomSincePos;
      connectionState.roomStates[roomId] = {
        sentState: true,
        lastStreamOrdering: newStreamOrdering,
      };
    }
  }

  // Handle unsubscriptions
  if (body.unsubscribe_rooms) {
    for (const roomId of body.unsubscribe_rooms) {
      delete connectionState.roomStates[roomId];
    }
  }

  // Process extensions via shared builder (MSC3575 + MSC4186 unified logic)
  if (body.extensions) {
    const extensionKeys = Object.keys(body.extensions);
    console.log("[sliding-sync] Extensions requested:", extensionKeys, "by user:", userId);

    const visibilityContext = await loadSlidingSyncVisibilityContext(db, userId);

    const extensions = await buildSlidingSyncExtensions(
      {
        userId,
        deviceId: c.get("deviceId") ?? null,
        db,
        env: c.env,
        sincePos,
        isInitialSync: !posToken,
        responseRoomIds: toRoomIds(Object.keys(response.rooms)),
        subscribedRoomIds: body.room_subscriptions
          ? toRoomIds(Object.keys(body.room_subscriptions))
          : [],
        visibilityContext,
      },
      body.extensions,
    );
    Object.assign(response.extensions, extensions);
  }

  // ALWAYS save connection state - using DO now (not KV), no rate limit concerns
  try {
    await persistConnectionState(syncDO, userId, connId, connectionState);
  } catch (error) {
    console.error("[sliding-sync MSC3575] Failed to save connection state:", error);
  }

  return response;
}

// MSC3575 Sliding Sync endpoint
app.post("/_matrix/client/unstable/org.matrix.msc3575/sync", requireAuth(), async (c) => {
  let body: SlidingSyncRequest;
  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  try {
    const response = await runClientEffect(
      Effect.promise(() => buildMsc3575SlidingSyncResponse(c, body)),
    );
    return response instanceof Response ? response : c.json(response);
  } catch (error) {
    if (error instanceof Error && "toResponse" in error) {
      return (error as { toResponse(): Response }).toResponse();
    }
    throw error;
  }
});

// Helper to detect if a request looks like it's from the iOS NSE (Notification Service Extension)
// NSE requests are typically:
// - Single room subscription (the room with the push notification)
// - Minimal or no extensions
// - User-agent may differ from main app
// - Made shortly after push notification delivery
function detectNSERequest(
  userAgent: string | undefined,
  body: SlidingSyncRequest,
): { isLikelyNSE: boolean; indicators: string[] } {
  const indicators: string[] = [];

  // Check User-Agent patterns
  // Element X iOS NSE typically has "NSE" in User-Agent or different app name
  if (userAgent) {
    if (userAgent.includes("NSE") || userAgent.includes("NotificationService")) {
      indicators.push("user-agent-nse");
    }
    // Element X iOS main app pattern: "Element X iOS/..."
    // NSE might use different pattern
    if (!userAgent.includes("Element X iOS") && userAgent.includes("iOS")) {
      indicators.push("user-agent-different-ios");
    }
  }

  // Check request shape - NSE typically subscribes to single room
  const roomSubscriptions = body.room_subscriptions
    ? toRoomIds(Object.keys(body.room_subscriptions))
    : [];
  const lists = body.lists ? Object.keys(body.lists) : [];

  if (roomSubscriptions.length === 1 && lists.length === 0) {
    indicators.push("single-room-subscription");
  }

  // Check for minimal extensions (NSE only needs room content)
  const extensionKeys = body.extensions ? Object.keys(body.extensions) : [];
  if (extensionKeys.length === 0) {
    indicators.push("no-extensions");
  } else if (
    extensionKeys.length <= 2 &&
    !extensionKeys.includes("typing") &&
    !extensionKeys.includes("presence")
  ) {
    indicators.push("minimal-extensions");
  }

  // NSE typically requests small timeline
  if (body.room_subscriptions) {
    const subscriptions = Object.values(body.room_subscriptions);
    const allSmallTimeline = subscriptions.every((s) => (s.timeline_limit ?? 10) <= 5);
    if (allSmallTimeline && subscriptions.length > 0) {
      indicators.push("small-timeline-limit");
    }
  }

  // Consider it likely NSE if we have 2+ indicators
  const isLikelyNSE = indicators.length >= 2;

  return { isLikelyNSE, indicators };
}

// MSC4186 Simplified Sliding Sync builder (shared between endpoints)
async function buildSimplifiedSlidingSyncResponse(
  c: Context<AppEnv>,
  body: SlidingSyncRequest,
): Promise<SlidingSyncResponse | Response> {
  const userId = toUserId(c.get("userId"));
  if (!userId) {
    return Errors.invalidParam("userId", "Invalid user ID").toResponse();
  }
  const db = c.env.DB;
  const syncDO = c.env.SYNC; // Use Durable Object for connection state (not KV - avoids rate limits)

  // Capture User-Agent for NSE detection
  const userAgent = c.req.header("User-Agent");

  const connId = body.conn_id ?? "default";

  // NSE Detection - log potential NSE requests
  const nseDetection = detectNSERequest(userAgent, body);
  if (nseDetection.isLikelyNSE || nseDetection.indicators.length > 0) {
    console.log("[sliding-sync] POTENTIAL NSE REQUEST:", {
      userId,
      userAgent,
      isLikelyNSE: nseDetection.isLikelyNSE,
      indicators: nseDetection.indicators,
      roomSubscriptions: body.room_subscriptions
        ? toRoomIds(Object.keys(body.room_subscriptions))
        : [],
      extensions: body.extensions ? Object.keys(body.extensions) : [],
      timestamp: new Date().toISOString(),
    });
  }

  // Parse timeout for long-polling (query string takes precedence, then body, default 0)
  const queryTimeout = c.req.query("timeout");
  const timeout = Math.min(
    queryTimeout ? parseInt(queryTimeout, 10) : (body.timeout ?? 0),
    25000, // Cap at 25s to stay under Workers 30s limit
  );

  // Get current stream position from database
  const currentStreamPos = await getCurrentStreamPosition(db);

  // Get or create connection state
  let connectionState: ConnectionState | null;
  try {
    connectionState = await loadConnectionState(syncDO, userId, connId);
  } catch (error) {
    // DO unavailable - return error so client knows to retry
    console.error("[sliding-sync] DO unavailable:", error);
    return c.json(
      {
        errcode: "M_UNKNOWN",
        error: "Sync service temporarily unavailable",
      },
      503,
    );
  }

  // IMPORTANT: pos can be in query string OR body - check both
  // Element X sends pos in query string, other clients may use body
  const queryPos = c.req.query("pos");
  const posToken = queryPos ?? body.pos;
  const sincePos = posToken ? parseInt(posToken, 10) : 0;

  // Debug logging for connection state (includes user-agent for NSE debugging)
  console.log("[sliding-sync] Request:", {
    userId,
    connId,
    timeout,
    queryPos,
    bodyPos: body.pos,
    sincePos,
    currentStreamPos,
    hasConnectionState: !!connectionState,
    hasLists: !!body.lists && Object.keys(body.lists).length > 0,
    hasRoomSubscriptions:
      !!body.room_subscriptions && Object.keys(body.room_subscriptions).length > 0,
    hasExtensions: !!body.extensions,
    extensionKeys: body.extensions ? Object.keys(body.extensions) : [],
    userAgent: userAgent?.slice(0, 100), // Truncate for log readability
  });

  // If client sends a pos but we don't have connection state, check if the pos
  // is a valid stream position (could be from before a deployment or KV expiry)
  // If it's <= current position, treat as reconnect and rebuild state
  if (posToken && !connectionState) {
    if (sincePos <= currentStreamPos) {
      // Valid position, create fresh connection state treating it as a reconnect
      console.log(
        "[sliding-sync] Reconnecting with valid pos",
        sincePos,
        "current:",
        currentStreamPos,
      );
      connectionState = {
        userId,
        pos: sincePos,
        lastAccess: Date.now(),
        roomStates: {},
        listStates: {},
      };
    } else {
      // Position is in the future - invalid
      return c.json(
        {
          errcode: "M_UNKNOWN_POS",
          error: "Unknown position token",
        },
        400,
      );
    }
  }

  const isInitialSync = !posToken || sincePos === 0;

  connectionState ??= {
    userId,
    pos: 0,
    lastAccess: Date.now(),
    roomStates: {},
    listStates: {},
  };

  // Track whether there are any actual changes to report
  let hasChanges = isInitialSync; // Initial sync always has "changes"

  // Don't update connection state position yet - only if we have changes
  connectionState.lastAccess = Date.now();

  const response: SlidingSyncResponse = {
    pos: posToken ?? String(currentStreamPos), // Start with input pos, update later if changes
    lists: {},
    rooms: {},
    extensions: {},
  };

  if (body.txn_id) {
    response.txn_id = body.txn_id;
  }

  // Track max stream ordering we process
  let maxStreamOrdering = sincePos;

  // Process lists (MSC4186 uses single 'range' instead of 'ranges')
  if (body.lists) {
    for (const [listKey, listConfig] of Object.entries(body.lists)) {
      const rooms = await getUserRooms(db, userId, listConfig.filters, listConfig.sort);

      let startIndex = 0;
      let endIndex = rooms.length - 1;

      if (listConfig.range) {
        startIndex = listConfig.range[0];
        endIndex = Math.min(listConfig.range[1], rooms.length - 1);
      } else if (listConfig.ranges && listConfig.ranges.length > 0) {
        startIndex = listConfig.ranges[0][0];
        endIndex = Math.min(listConfig.ranges[0][1], rooms.length - 1);
      }

      const roomsInRange = rooms.slice(startIndex, endIndex + 1);
      const roomIds = roomsInRange.map((r) => r.roomId);

      // Check if the list has changed since last sync
      const previousListState = connectionState.listStates[listKey];
      const listChanged = didSlidingSyncListChange(previousListState, roomIds, rooms.length);

      // Only include ops if the list changed (or it's an initial sync)
      if (listChanged) {
        hasChanges = true; // Mark that we have actual changes
        response.lists[listKey] = {
          count: rooms.length,
          ops: [
            {
              op: "SYNC",
              range: [startIndex, endIndex],
              room_ids: roomIds,
            },
          ],
        };
      } else {
        // List unchanged - just report count with no ops
        response.lists[listKey] = {
          count: rooms.length,
        };
      }

      for (const roomInfo of roomsInRange) {
        const roomState = connectionState.roomStates[roomInfo.roomId];
        const isInitialRoom = !roomState?.sentState;
        const roomSincePos = isInitialRoom ? 0 : (roomState?.lastStreamOrdering ?? sincePos);

        // Handle invited rooms differently - they get invite_state not timeline
        // Always include invited room data (small payload) so client doesn't lose invites on reconnect
        if (roomInfo.membership === "invite") {
          const roomData = await getInviteRoomData(db, roomInfo.roomId, userId);
          hasChanges = true; // Mark that we have actual changes
          response.rooms[roomInfo.roomId] = roomData;
          connectionState.roomStates[roomInfo.roomId] = {
            sentState: true,
            lastStreamOrdering: roomSincePos,
          };
          continue;
        }

        // For joined rooms, get full room data
        const roomData = await getRoomData(db, roomInfo.roomId, userId, {
          requiredState: listConfig.required_state,
          timelineLimit: listConfig.timeline_limit ?? 10,
          initial: isInitialRoom,
          sinceStreamOrdering: isInitialRoom ? undefined : roomSincePos,
        });

        // Check if notification count changed (for marking rooms as read)
        const hasPrevCount = roomInfo.roomId in (connectionState.roomNotificationCounts ?? {});
        const prevNotificationCount =
          connectionState.roomNotificationCounts?.[roomInfo.roomId] ?? 0;
        const currentNotificationCount = roomData.notification_count ?? 0;
        const notificationCountChanged =
          hasPrevCount && currentNotificationCount !== prevNotificationCount;

        // Check if m.fully_read marker changed (Element X uses this for encrypted rooms)
        const currentFullyRead = await getFullyReadMarker(db, userId, roomInfo.roomId);
        const fullyReadChanged = readMarkerChanged(
          connectionState.roomFullyReadMarkers?.[roomInfo.roomId],
          currentFullyRead,
        );

        // Track if this is the first time we're sending this room as "read" (notification_count = 0)
        // This ensures Element X receives the room with 0 unread count at least once
        const shouldMarkFirstRead = firstTimeRead(
          connectionState,
          roomInfo.roomId,
          currentNotificationCount,
        );

        // Include room if it's initial, has new events, notification count changed, fully_read changed, OR first time read
        if (
          shouldIncludeSlidingSyncRoom({
            isInitialRoom,
            timelineEventCount: roomData.timeline?.length ?? 0,
            notificationCountChanged,
            fullyReadChanged,
            firstTimeRead: shouldMarkFirstRead,
          })
        ) {
          hasChanges = true; // Mark that we have actual changes
          response.rooms[roomInfo.roomId] = roomData;
          if (currentFullyRead) {
            trackSlidingSyncRoomReadState(
              connectionState,
              roomInfo.roomId,
              currentNotificationCount,
              currentFullyRead,
            );
          }
        }

        // Update room state tracking
        const newStreamOrdering = roomData.maxStreamOrdering ?? roomSincePos;
        connectionState.roomStates[roomInfo.roomId] = {
          sentState: true,
          lastStreamOrdering: newStreamOrdering,
        };

        if (newStreamOrdering > maxStreamOrdering) {
          maxStreamOrdering = newStreamOrdering;
        }
      }

      connectionState.listStates[listKey] = {
        roomIds,
        count: rooms.length,
      };
    }
  }

  // Process room subscriptions
  if (body.room_subscriptions) {
    for (const [roomId, subscription] of toRoomEntries(body.room_subscriptions)) {
      const subscriptionConfig = subscription as {
        required_state?: [string, string][];
        timeline_limit?: number;
      };
      const membershipResult = await db
        .prepare(`
        SELECT membership FROM room_memberships WHERE room_id = ? AND user_id = ?
      `)
        .bind(roomId, userId)
        .first();

      if (!membershipResult) continue;

      const roomState = connectionState.roomStates[roomId];
      const isInitialRoom = !roomState?.sentState;
      const roomSincePos = isInitialRoom ? 0 : (roomState?.lastStreamOrdering ?? sincePos);

      // Handle invited rooms differently - they get invite_state not timeline
      // Always include invited room data (small payload) so client doesn't lose invites on reconnect
      if (membershipResult.membership === "invite") {
        const roomData = await getInviteRoomData(db, roomId, userId);
        hasChanges = true; // Mark that we have actual changes
        response.rooms[roomId] = roomData;
        connectionState.roomStates[roomId] = {
          sentState: true,
          lastStreamOrdering: roomSincePos,
        };
        continue;
      }

      // For joined rooms, get full room data
      const roomData = await getRoomData(db, roomId, userId, {
        requiredState: subscriptionConfig.required_state,
        timelineLimit: subscriptionConfig.timeline_limit ?? 10,
        initial: isInitialRoom,
        sinceStreamOrdering: isInitialRoom ? undefined : roomSincePos,
      });

      // Check if notification count changed (for marking rooms as read)
      const hasPrevCount = roomId in (connectionState.roomNotificationCounts ?? {});
      const prevNotificationCount = connectionState.roomNotificationCounts?.[roomId] ?? 0;
      const currentNotificationCount = roomData.notification_count ?? 0;
      const notificationCountChanged =
        hasPrevCount && currentNotificationCount !== prevNotificationCount;

      // Check if m.fully_read marker changed (Element X uses this for encrypted rooms)
      const currentFullyRead = await getFullyReadMarker(db, userId, roomId);
      const fullyReadChanged = readMarkerChanged(
        connectionState.roomFullyReadMarkers?.[roomId],
        currentFullyRead,
      );

      // Track if this is the first time we're sending this room as "read" (notification_count = 0)
      const shouldMarkFirstRead = firstTimeRead(connectionState, roomId, currentNotificationCount);

      // For room subscriptions, ALWAYS include room data because client explicitly requested it
      // This is different from list-based sync - room subscriptions mean "give me this room's data"
      // Element X needs this when opening a room to display timeline and state
      hasChanges = true;
      response.rooms[roomId] = roomData;

      // Also track for legacy reasons (notification changes, read status)
      if (
        shouldIncludeSlidingSyncRoom({
          isInitialRoom,
          timelineEventCount: roomData.timeline?.length ?? 0,
          notificationCountChanged,
          fullyReadChanged,
          firstTimeRead: shouldMarkFirstRead,
          explicitSubscription: true,
        })
      ) {
        if (currentFullyRead) {
          trackSlidingSyncRoomReadState(
            connectionState,
            roomId,
            currentNotificationCount,
            currentFullyRead,
          );
        }
      }

      const newStreamOrdering = roomData.maxStreamOrdering ?? roomSincePos;
      connectionState.roomStates[roomId] = {
        sentState: true,
        lastStreamOrdering: newStreamOrdering,
      };

      if (newStreamOrdering > maxStreamOrdering) {
        maxStreamOrdering = newStreamOrdering;
      }
    }
  }

  // Handle extensions via shared builder (MSC3575 + MSC4186 unified logic)
  // Note: Extensions are considered enabled if the key exists OR if enabled=true.
  // Element X sends extensions without explicit enabled:true.
  if (body.extensions) {
    const enabledExtensions = Object.keys(body.extensions).filter((k) => {
      const ext = (body.extensions as Record<string, unknown>)[k];
      return ext !== undefined && ext !== null;
    });
    console.log("[sliding-sync] Extensions requested:", enabledExtensions);

    const visibilityContext = await loadSlidingSyncVisibilityContext(db, userId);

    const currentResponseRoomIds = toRoomIds(Object.keys(response.rooms));
    const subscribedRoomIds = body.room_subscriptions
      ? toRoomIds(Object.keys(body.room_subscriptions))
      : [];

    // MSC4186 compatibility: typing is included even when not explicitly requested
    // if rooms are in the response (Element X relies on this behaviour).
    const effectiveExtensions = {
      ...body.extensions,
      typing:
        body.extensions.typing ??
        (currentResponseRoomIds.length > 0
          ? ({} as SlidingSyncExtensionConfig["typing"])
          : undefined),
    };

    const extensions = await buildSlidingSyncExtensions(
      {
        userId,
        deviceId: c.get("deviceId") ?? null,
        db,
        env: c.env,
        sincePos,
        isInitialSync: !body.pos,
        responseRoomIds: currentResponseRoomIds,
        subscribedRoomIds,
        visibilityContext,
      },
      effectiveExtensions,
    );
    Object.assign(response.extensions, extensions);
  }

  // Include ephemeral data on INITIAL sync only if extensions weren't requested
  // Running this on every sync causes spam - clients sync rapidly when they receive data
  // Element X typically requests extensions properly on incremental syncs
  // Use initialSyncComplete flag to track if we've already done initial sync for this connection,
  // since clients can reconnect with sincePos === 0 but we shouldn't spam ephemeral data again
  const needsEphemeralFallback =
    !connectionState.initialSyncComplete &&
    (!body.extensions || Object.keys(body.extensions).length === 0);

  if (needsEphemeralFallback) {
    const userRoomIds = await getJoinedRoomIdsIncludingPartialState(db, userId);

    // Fallback: Include typing for all rooms - uses Room Durable Objects
    const typingByRoom = await getTypingForRooms(c.env, userRoomIds);

    // Always include typing for all rooms so clients know when typing stops
    response.extensions.typing = { rooms: {} };
    for (const roomId of userRoomIds) {
      const userIds = typingByRoom[roomId] || [];
      response.extensions.typing.rooms![roomId] = {
        type: "m.typing",
        content: { user_ids: userIds },
      };
    }

    // Fallback: Include receipts for all user's rooms - uses Room Durable Objects
    // Pass userId to filter m.read.private receipts
    const receiptsByRoom = await getReceiptsForRooms(c.env, userRoomIds, userId);

    response.extensions.receipts = { rooms: {} };
    for (const [roomId, content] of toRoomEntries(
      receiptsByRoom as Record<RoomId, Record<string, unknown>>,
    )) {
      response.extensions.receipts.rooms![roomId] = {
        type: "m.receipt",
        content,
      };
    }

    // Fallback: Include room account_data (especially m.fully_read for unread counts)
    // Element X needs m.fully_read to calculate unread counts
    // IMPORTANT: Also ensure room is in response.rooms so Element X processes the account_data
    response.extensions.account_data = { global: [], rooms: {} };
    for (const roomId of userRoomIds) {
      const roomAccountData = await db
        .prepare(`
        SELECT event_type, content FROM account_data
        WHERE user_id = ? AND room_id = ?
      `)
        .bind(userId, roomId)
        .all();

      if (roomAccountData.results.length > 0) {
        response.extensions.account_data.rooms![roomId] = (roomAccountData.results as any[]).map(
          (d) => {
            try {
              return { type: d.event_type, content: JSON.parse(d.content) };
            } catch {
              return { type: d.event_type, content: {} };
            }
          },
        );
      }
    }
  }

  // Always advance position to prevent client re-sync loops
  // Previously we only set pos when hasChanges, but this caused clients to receive
  // the same pos twice and immediately re-sync, thinking it was stale
  response.pos = String(Math.max(currentStreamPos, maxStreamOrdering));
  connectionState.pos = currentStreamPos;

  // Mark initial sync as complete so ephemeral fallback doesn't run again on reconnects
  connectionState.initialSyncComplete ??= true;

  // Debug logging for response
  console.log("[sliding-sync] Response:", {
    userId,
    responsePos: response.pos,
    hasChanges,
    timeout,
    willWait: !hasChanges && timeout > 0,
  });

  // ALWAYS save connection state - flags like initialSyncComplete must be persisted
  // We use Durable Objects now (not KV), so rate limits aren't a concern
  // Previously we only saved when hasChanges, but this caused initialSyncComplete
  // to not persist, resulting in ephemeral data spam on every request
  try {
    await persistConnectionState(syncDO, userId, connId, connectionState);
  } catch (error) {
    console.error("[sliding-sync] Failed to save connection state:", error);
    // Don't return error here - state can be rebuilt on next request
    // But client may experience duplicated ephemeral data
  }

  // Long-polling: if no changes and timeout > 0, wait for events via Durable Object
  // The SyncDurableObject will wake us up when events arrive for this user
  // Per MSC3575/MSC4186, server should wait up to timeout ms for new events
  if (!hasChanges && timeout > 0) {
    console.log("[sliding-sync] No changes, waiting for events via DO, timeout:", timeout, "ms");
    try {
      const waitResult = await waitForSlidingSyncEvents(syncDO, userId, timeout);

      if (waitResult.hasEvents) {
        console.log("[sliding-sync] Woken up early - events arrived");
        // Events arrived while waiting - return immediately so client makes new request
        // The next request will pick up the new events
      } else {
        console.log("[sliding-sync] Wait timed out, no new events");
      }
    } catch (error) {
      console.error("[sliding-sync] Error waiting for events:", error);
      // Fall through and return current response on error
    }
  }

  return response;
}

async function handleSimplifiedSlidingSync(c: Context<AppEnv>) {
  let body: SlidingSyncRequest;
  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  try {
    const response = await runClientEffect(
      Effect.promise(() => buildSimplifiedSlidingSyncResponse(c, body)),
    );
    return response instanceof Response ? response : c.json(response);
  } catch (error) {
    if (error instanceof Error && "toResponse" in error) {
      return (error as { toResponse(): Response }).toResponse();
    }
    throw error;
  }
}

// MSC4186 Simplified Sliding Sync - unstable endpoint (used by Element X)
app.post(
  "/_matrix/client/unstable/org.matrix.simplified_msc3575/sync",
  requireAuth(),
  handleSimplifiedSlidingSync,
);

// MSC4186 Simplified Sliding Sync endpoint (v4)
app.post("/_matrix/client/v4/sync", requireAuth(), handleSimplifiedSlidingSync);

export default app;
