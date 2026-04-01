// Push Rule Evaluator Service
// Provides notification and highlight counting using push rule evaluation
// Extracted for use by sync and sliding-sync endpoints

import { runClientEffect } from "../matrix/application/effect-runtime";
import { withLogContext } from "../matrix/application/logging";
import { evaluatePushRules } from "../api/push";

export { evaluatePushRules };

interface UnreadEvent {
  event_id: string;
  event_type: string;
  content: string;
  sender: string;
  room_id: string;
  state_key?: string;
}

interface UnreadNotificationCandidate extends UnreadEvent {
  stream_ordering: number;
  thread_root: string | null;
}

interface ReceiptUserData {
  ts: number;
  thread_id?: string;
}

type ReceiptContent = Record<string, Record<string, Record<string, ReceiptUserData>>>;

export interface UnreadNotificationCounts {
  notification_count: number;
  highlight_count: number;
}

export interface UnreadNotificationSummary {
  room: UnreadNotificationCounts;
  main: UnreadNotificationCounts;
  threads: Record<string, UnreadNotificationCounts>;
}

function createUnreadCounts(): UnreadNotificationCounts {
  return { notification_count: 0, highlight_count: 0 };
}

function incrementUnreadCounts(counts: UnreadNotificationCounts, highlight: boolean): void {
  counts.notification_count += 1;
  if (highlight) {
    counts.highlight_count += 1;
  }
}

async function resolveEventStreamOrdering(db: D1Database, eventId: string): Promise<number | null> {
  const event = await db
    .prepare(
      `
      SELECT stream_ordering FROM events WHERE event_id = ?
    `,
    )
    .bind(eventId)
    .first<{ stream_ordering: number }>();
  return event?.stream_ordering ?? null;
}

async function resolveRoomReadBoundary(
  db: D1Database,
  userId: string,
  roomId: string,
): Promise<number> {
  const fullyReadMarker = await db
    .prepare(
      `
      SELECT content FROM account_data
      WHERE user_id = ? AND room_id = ? AND event_type = 'm.fully_read'
    `,
    )
    .bind(userId, roomId)
    .first<{ content: string }>();

  if (!fullyReadMarker) {
    return 0;
  }

  try {
    const markerContent = JSON.parse(fullyReadMarker.content) as { event_id?: string };
    if (typeof markerContent.event_id !== "string") {
      return 0;
    }
    return (await resolveEventStreamOrdering(db, markerContent.event_id)) ?? 0;
  } catch {
    return 0;
  }
}

async function resolveReceiptBoundaries(
  db: D1Database,
  userId: string,
  roomId: string,
  receipts: ReceiptContent,
): Promise<{
  roomBoundary: number;
  mainBoundary: number;
  threadBoundaries: Map<string, number>;
}> {
  let roomBoundary = await resolveRoomReadBoundary(db, userId, roomId);
  let mainBoundary = roomBoundary;
  const threadBoundaries = new Map<string, number>();

  for (const [eventId, receiptTypes] of Object.entries(receipts)) {
    for (const [receiptType, users] of Object.entries(receiptTypes)) {
      if (receiptType !== "m.read" && receiptType !== "m.read.private") {
        continue;
      }

      const userReceipt = users[userId];
      if (!userReceipt) {
        continue;
      }

      const streamOrdering = await resolveEventStreamOrdering(db, eventId);
      if (streamOrdering === null) {
        continue;
      }

      const threadId = userReceipt.thread_id;
      if (threadId === undefined) {
        roomBoundary = Math.max(roomBoundary, streamOrdering);
        mainBoundary = Math.max(mainBoundary, roomBoundary);
        continue;
      }

      if (threadId === "main") {
        mainBoundary = Math.max(mainBoundary, streamOrdering, roomBoundary);
        continue;
      }

      threadBoundaries.set(
        threadId,
        Math.max(threadBoundaries.get(threadId) ?? roomBoundary, roomBoundary, streamOrdering),
      );
    }
  }

  mainBoundary = Math.max(mainBoundary, roomBoundary);
  for (const [threadId, boundary] of threadBoundaries.entries()) {
    threadBoundaries.set(threadId, Math.max(boundary, roomBoundary));
  }

  return { roomBoundary, mainBoundary, threadBoundaries };
}

async function getUnreadNotificationCandidates(
  db: D1Database,
  userId: string,
  roomId: string,
): Promise<UnreadNotificationCandidate[]> {
  const results = await db
    .prepare(
      `
      SELECT
        e.event_id,
        e.event_type,
        e.content,
        e.sender,
        e.room_id,
        e.state_key,
        e.stream_ordering,
        thread_rel.relates_to_id AS thread_root
      FROM events e
      LEFT JOIN event_relations thread_rel
        ON thread_rel.event_id = e.event_id
       AND thread_rel.relation_type = 'm.thread'
      WHERE e.room_id = ?
        AND e.sender != ?
        AND e.event_type IN ('m.room.message', 'm.room.encrypted')
      ORDER BY e.stream_ordering ASC
      LIMIT 500
    `,
    )
    .bind(roomId, userId)
    .all<UnreadNotificationCandidate>();

  return results.results;
}

export async function countUnreadNotificationSummaryWithRules(
  db: D1Database,
  userId: string,
  roomId: string,
  receipts: ReceiptContent,
): Promise<UnreadNotificationSummary> {
  const logger = withLogContext({
    component: "push",
    operation: "count_unread_summary",
    room_id: roomId,
    user_id: userId,
    debugEnabled: true,
  });
  const [candidates, boundaries, memberCount, user] = await Promise.all([
    getUnreadNotificationCandidates(db, userId, roomId),
    resolveReceiptBoundaries(db, userId, roomId, receipts),
    db
      .prepare(
        `
        SELECT COUNT(*) as count FROM room_memberships
        WHERE room_id = ? AND membership = 'join'
      `,
      )
      .bind(roomId)
      .first<{ count: number }>(),
    db
      .prepare(
        `
        SELECT display_name FROM users WHERE user_id = ?
      `,
      )
      .bind(userId)
      .first<{ display_name: string | null }>(),
  ]);

  const summary: UnreadNotificationSummary = {
    room: createUnreadCounts(),
    main: createUnreadCounts(),
    threads: {},
  };

  await runClientEffect(
    logger.debug("push.project.unread_summary_start", {
      candidate_count: candidates.length,
      room_boundary: boundaries.roomBoundary,
      main_boundary: boundaries.mainBoundary,
      thread_boundaries: Object.fromEntries(boundaries.threadBoundaries),
    }),
  );

  for (const event of candidates) {
    let parsedContent: Record<string, unknown>;
    try {
      parsedContent = typeof event.content === "string" ? JSON.parse(event.content) : event.content;
    } catch {
      parsedContent = {};
    }

    const result = await evaluatePushRules(
      db,
      userId,
      {
        type: event.event_type,
        content: parsedContent,
        sender: event.sender,
        room_id: event.room_id,
        state_key: event.state_key,
      },
      memberCount?.count || 1,
      user?.display_name || undefined,
    );

    await runClientEffect(
      logger.debug("push.project.unread_summary_event", {
        event_id: event.event_id,
        event_type: event.event_type,
        stream_ordering: event.stream_ordering,
        thread_root: event.thread_root,
        notify: result.notify,
        highlight: result.highlight,
      }),
    );

    if (!result.notify) {
      continue;
    }

    if (event.thread_root) {
      const threadBoundary = Math.max(
        boundaries.threadBoundaries.get(event.thread_root) ?? boundaries.roomBoundary,
        boundaries.roomBoundary,
      );
      if (event.stream_ordering <= threadBoundary) {
        continue;
      }

      if (!summary.threads[event.thread_root]) {
        summary.threads[event.thread_root] = createUnreadCounts();
      }
      incrementUnreadCounts(summary.threads[event.thread_root], result.highlight);
      incrementUnreadCounts(summary.room, result.highlight);
      continue;
    }

    if (event.stream_ordering <= boundaries.mainBoundary) {
      continue;
    }

    incrementUnreadCounts(summary.main, result.highlight);
    incrementUnreadCounts(summary.room, result.highlight);
  }

  await runClientEffect(
    logger.debug("push.project.unread_summary_result", {
      room_notification_count: summary.room.notification_count,
      room_highlight_count: summary.room.highlight_count,
      main_notification_count: summary.main.notification_count,
      main_highlight_count: summary.main.highlight_count,
      thread_notification_count: Object.keys(summary.threads).length,
    }),
  );

  return summary;
}

/**
 * Count notifications and highlights for unread events in a room
 * using the user's push rules for accurate counting.
 */
export async function countNotificationsWithRules(
  db: D1Database,
  userId: string,
  roomId: string,
  sinceStreamOrdering?: number,
): Promise<{ notification_count: number; highlight_count: number }> {
  let readStreamOrdering = sinceStreamOrdering;
  if (readStreamOrdering === undefined) {
    readStreamOrdering = await resolveRoomReadBoundary(db, userId, roomId);
  }

  // Get unread events (messages and encrypted events from others)
  let unreadEvents: UnreadEvent[];
  if (readStreamOrdering) {
    const results = await db
      .prepare(`
      SELECT event_id, event_type, content, sender, room_id, state_key
      FROM events
      WHERE room_id = ? AND stream_ordering > ? AND sender != ?
        AND event_type IN ('m.room.message', 'm.room.encrypted')
      ORDER BY stream_ordering ASC
      LIMIT 500
    `)
      .bind(roomId, readStreamOrdering, userId)
      .all<UnreadEvent>();
    unreadEvents = results.results;
  } else {
    const results = await db
      .prepare(`
      SELECT event_id, event_type, content, sender, room_id, state_key
      FROM events
      WHERE room_id = ? AND sender != ?
        AND event_type IN ('m.room.message', 'm.room.encrypted')
      ORDER BY stream_ordering DESC
      LIMIT 500
    `)
      .bind(roomId, userId)
      .all<UnreadEvent>();
    unreadEvents = results.results;
  }

  if (unreadEvents.length === 0) {
    return { notification_count: 0, highlight_count: 0 };
  }

  // Get room member count for push rule evaluation
  const memberCount = await db
    .prepare(`
    SELECT COUNT(*) as count FROM room_memberships
    WHERE room_id = ? AND membership = 'join'
  `)
    .bind(roomId)
    .first<{ count: number }>();

  // Get user's display name for mention detection
  const user = await db
    .prepare(`
    SELECT display_name FROM users WHERE user_id = ?
  `)
    .bind(userId)
    .first<{ display_name: string | null }>();

  let notificationCount = 0;
  let highlightCount = 0;

  for (const event of unreadEvents) {
    let parsedContent: Record<string, unknown>;
    try {
      parsedContent = typeof event.content === "string" ? JSON.parse(event.content) : event.content;
    } catch {
      parsedContent = {};
    }

    const result = await evaluatePushRules(
      db,
      userId,
      {
        type: event.event_type,
        content: parsedContent,
        sender: event.sender,
        room_id: event.room_id,
        state_key: event.state_key,
      },
      memberCount?.count || 1,
      user?.display_name || undefined,
    );

    if (result.notify) {
      notificationCount++;
    }
    if (result.highlight) {
      highlightCount++;
    }
  }

  return { notification_count: notificationCount, highlight_count: highlightCount };
}
