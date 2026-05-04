import { sql, type RawBuilder } from "kysely";
import {
  createKyselyBuilder,
  executeKyselyQuery,
  executeKyselyQueryFirst,
  executeKyselyRun,
  type CompiledQuery,
} from "../db/kysely";
import type {
  EventId,
  MatrixSignatures,
  Membership,
  PDU,
  RoomId,
  UserId,
} from "../../../../fatrix-model/types";
import { toEventId, toRoomId, toUserId } from "../../../../fatrix-model/utils/ids";
import type {
  MembershipTransitionContext,
  MembershipTransitionResult,
  StrippedStateEvent,
} from "../../../../fatrix-backend/application/membership-transition-service";

interface MembershipTransitionDatabase {
  users: {
    user_id: string;
  };
  room_knocks: {
    room_id: string;
    user_id: string;
    reason: string | null;
    event_id: string;
    created_at: number;
  };
  room_state: {
    room_id: string;
    event_type: string;
    state_key: string;
    event_id: string;
  };
  events: {
    event_id: string;
    room_id: string;
    sender: string;
    event_type: string;
    state_key: string | null;
    content: string;
    origin_server_ts: number;
    unsigned: string | null;
    depth: number;
    auth_events: string;
    prev_events: string;
    event_origin: string | null;
    event_membership: string | null;
    prev_state: string | null;
    hashes: string | null;
    signatures: string | null;
    stream_ordering: number;
  };
  room_memberships: {
    room_id: string;
    user_id: string;
    membership: string;
    event_id: string;
    display_name: string | null;
    avatar_url: string | null;
  };
  invite_stripped_state: {
    room_id: string;
    event_type: string;
    state_key: string;
    content: string;
    sender: string;
  };
}

const qb = createKyselyBuilder<MembershipTransitionDatabase>();

function asCompiledQuery<T>(query: RawBuilder<T>): CompiledQuery {
  return {
    compile: () => query.compile(qb),
  };
}

type StoredEventRow = MembershipTransitionDatabase["events"];

function parseJson<T>(value: string | null | undefined, fallback?: T): T | undefined {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function rowToPdu(row: StoredEventRow): PDU {
  const eventId = toEventId(row.event_id);
  const roomId = toRoomId(row.room_id);
  const sender = toUserId(row.sender);
  if (!eventId || !roomId || !sender) {
    throw new TypeError("Membership transition event row contains invalid Matrix identifiers");
  }

  return {
    event_id: eventId,
    room_id: roomId,
    sender,
    type: row.event_type,
    state_key: row.state_key ?? undefined,
    content: parseJson<Record<string, unknown>>(row.content, {}) ?? {},
    unsigned: parseJson<Record<string, unknown> | undefined>(row.unsigned),
    origin_server_ts: row.origin_server_ts,
    depth: row.depth,
    auth_events: (parseJson<string[]>(row.auth_events, []) ?? []).flatMap((id) => {
      const typedId = toEventId(id);
      return typedId ? [typedId] : [];
    }),
    prev_events: (parseJson<string[]>(row.prev_events, []) ?? []).flatMap((id) => {
      const typedId = toEventId(id);
      return typedId ? [typedId] : [];
    }),
    origin: row.event_origin ?? undefined,
    membership: (row.event_membership as Membership | null) ?? undefined,
    prev_state: (parseJson<string[]>(row.prev_state, []) ?? []).flatMap((id) => {
      const typedId = toEventId(id);
      return typedId ? [typedId] : [];
    }),
    hashes: parseJson<{ sha256: string } | undefined>(row.hashes),
    signatures: parseJson<MatrixSignatures | undefined>(row.signatures),
  };
}

async function getMembershipForTransition(
  db: D1Database,
  roomId: RoomId,
  userId: UserId,
): Promise<{ membership: Membership; eventId: EventId; streamOrdering?: number } | null> {
  const row = await executeKyselyQueryFirst<{
    membership: Membership;
    event_id: string;
    stream_ordering: number | null;
  }>(
    db,
    asCompiledQuery(sql<{
      membership: Membership;
      event_id: string;
      stream_ordering: number | null;
    }>`
      WITH membership_sources AS (
        SELECT rm.membership, rm.event_id, e.stream_ordering, 1 AS precedence
        FROM room_memberships rm
        LEFT JOIN events e ON e.event_id = rm.event_id
        WHERE rm.room_id = ${roomId} AND rm.user_id = ${userId}

        UNION ALL

        SELECT
          json_extract(e.content, '$.membership') AS membership,
          rs.event_id AS event_id,
          e.stream_ordering AS stream_ordering,
          2 AS precedence
        FROM room_state rs
        JOIN events e ON rs.event_id = e.event_id
        WHERE rs.room_id = ${roomId}
          AND rs.event_type = 'm.room.member'
          AND rs.state_key = ${userId}
          AND NOT EXISTS (
            SELECT 1
            FROM room_memberships rm
            WHERE rm.room_id = rs.room_id
              AND rm.user_id = rs.state_key
          )
      )
      SELECT membership, event_id, stream_ordering
      FROM membership_sources
      WHERE membership IN ('join', 'invite', 'leave', 'ban', 'knock')
      ORDER BY precedence
      LIMIT 1
    `),
  );

  const eventId = row ? toEventId(row.event_id) : null;
  return row && eventId
    ? {
        membership: row.membership,
        eventId,
        ...(row.stream_ordering !== null ? { streamOrdering: row.stream_ordering } : {}),
      }
    : null;
}

async function getRoomStateForTransition(db: D1Database, roomId: RoomId): Promise<PDU[]> {
  const rows = await executeKyselyQuery<StoredEventRow>(
    db,
    asCompiledQuery(sql<StoredEventRow>`
      SELECT e.event_id, e.room_id, e.sender, e.event_type, e.state_key, e.content,
             e.origin_server_ts, e.unsigned, e.depth, e.auth_events, e.prev_events,
             e.event_origin, e.event_membership, e.prev_state, e.hashes, e.signatures,
             e.stream_ordering
      FROM room_state rs
      JOIN events e ON rs.event_id = e.event_id
      WHERE rs.room_id = ${roomId}
    `),
  );

  const events = rows.map((row) => rowToPdu(row));
  if (!events.some((event) => event.type === "m.room.create")) {
    const createEvent = await getCreateEventFallback(db, roomId);
    if (createEvent) {
      events.push(createEvent);
    }
  }

  return events;
}

async function getCreateEventFallback(db: D1Database, roomId: RoomId): Promise<PDU | null> {
  const row = await executeKyselyQueryFirst<StoredEventRow>(
    db,
    asCompiledQuery(sql<StoredEventRow>`
      SELECT event_id, room_id, sender, event_type, state_key, content,
             origin_server_ts, unsigned, depth, auth_events, prev_events,
             event_origin, event_membership, prev_state, hashes, signatures,
             stream_ordering
      FROM events
      WHERE room_id = ${roomId} AND event_type = 'm.room.create'
      LIMIT 1
    `),
  );

  return row ? rowToPdu(row) : null;
}

async function getStateEventForTransition(
  db: D1Database,
  roomId: RoomId,
  eventType: string,
  stateKey = "",
): Promise<PDU | null> {
  const row = await executeKyselyQueryFirst<StoredEventRow>(
    db,
    asCompiledQuery(sql<StoredEventRow>`
      SELECT e.event_id, e.room_id, e.sender, e.event_type, e.state_key, e.content,
             e.origin_server_ts, e.unsigned, e.depth, e.auth_events, e.prev_events,
             e.event_origin, e.event_membership, e.prev_state, e.hashes, e.signatures,
             e.stream_ordering
      FROM room_state rs
      JOIN events e ON rs.event_id = e.event_id
      WHERE rs.room_id = ${roomId}
        AND rs.event_type = ${eventType}
        AND rs.state_key = ${stateKey}
      LIMIT 1
    `),
  );

  if (!row && eventType === "m.room.create" && stateKey === "") {
    return getCreateEventFallback(db, roomId);
  }

  return row ? rowToPdu(row) : null;
}

async function getInviteStrippedStateForTransition(
  db: D1Database,
  roomId: RoomId,
): Promise<StrippedStateEvent[]> {
  const rows = await executeKyselyQuery<{
    event_type: string;
    state_key: string;
    content: string;
    sender: string;
  }>(
    db,
    asCompiledQuery(sql<{
      event_type: string;
      state_key: string;
      content: string;
      sender: string;
    }>`
      SELECT event_type, state_key, content, sender
      FROM invite_stripped_state
      WHERE room_id = ${roomId}
    `),
  );

  return rows.flatMap((row) => {
    const sender = toUserId(row.sender);
    return sender
      ? [
          {
            type: row.event_type,
            state_key: row.state_key,
            content: parseJson<Record<string, unknown>>(row.content, {}) ?? {},
            sender,
          },
        ]
      : [];
  });
}

async function updateMembershipForTransition(
  db: D1Database,
  roomId: RoomId,
  userId: UserId,
  membership: Membership,
  eventId: EventId,
  displayName?: string,
  avatarUrl?: string,
): Promise<void> {
  await executeKyselyRun(
    db,
    asCompiledQuery(sql`
      INSERT OR REPLACE INTO room_memberships
        (room_id, user_id, membership, event_id, display_name, avatar_url)
      VALUES (${roomId}, ${userId}, ${membership}, ${eventId}, ${displayName ?? null}, ${avatarUrl ?? null})
    `),
  );

  if (membership === "invite") {
    return;
  }

  const remainingInvites = await executeKyselyQueryFirst<{ count: number | string }>(
    db,
    asCompiledQuery(sql<{ count: number | string }>`
      SELECT COUNT(*) AS count
      FROM room_memberships
      WHERE room_id = ${roomId} AND membership = 'invite'
    `),
  );

  if (Number(remainingInvites?.count ?? 0) === 0) {
    await executeKyselyRun(
      db,
      asCompiledQuery(sql`
        DELETE FROM invite_stripped_state
        WHERE room_id = ${roomId}
      `),
    );
  }
}

async function userExists(db: D1Database, userId: string): Promise<boolean> {
  const row = await executeKyselyQueryFirst<{ user_id: string }>(
    db,
    asCompiledQuery(sql<{ user_id: string }>`
      SELECT user_id FROM users WHERE user_id = ${userId} LIMIT 1
    `),
  );

  return row !== null;
}

export async function upsertMembershipTransitionKnockRecord(
  db: D1Database,
  roomId: string,
  userId: string,
  event: PDU,
): Promise<void> {
  if (!(await userExists(db, userId))) {
    return;
  }

  const content = event.content as { reason?: string } | undefined;
  await executeKyselyRun(
    db,
    asCompiledQuery(sql`
      INSERT OR REPLACE INTO room_knocks (room_id, user_id, reason, event_id, created_at)
      VALUES (${roomId}, ${userId}, ${content?.reason ?? null}, ${event.event_id}, ${Date.now()})
    `),
  );
}

export function clearMembershipTransitionKnockRecord(
  db: D1Database,
  roomId: string,
  userId: string,
): Promise<void> {
  return executeKyselyRun(
    db,
    asCompiledQuery(sql`
      DELETE FROM room_knocks
      WHERE room_id = ${roomId} AND user_id = ${userId}
    `),
  );
}

export function upsertMembershipTransitionRoomState(
  db: D1Database,
  roomId: string,
  eventType: string,
  stateKey: string,
  eventId: string,
): Promise<void> {
  return executeKyselyRun(
    db,
    asCompiledQuery(sql`
      INSERT OR REPLACE INTO room_state (room_id, event_type, state_key, event_id)
      VALUES (${roomId}, ${eventType}, ${stateKey}, ${eventId})
    `),
  );
}

export async function loadMembershipTransitionContextFromRepository(
  db: D1Database,
  roomId: string,
  stateKey?: string,
): Promise<MembershipTransitionContext> {
  const typedRoomId = toRoomId(roomId);
  const typedStateKey = stateKey ? toUserId(stateKey) : null;
  return {
    currentMembership:
      typedRoomId && typedStateKey
        ? await getMembershipForTransition(db, typedRoomId, typedStateKey)
        : null,
    currentMemberEvent:
      typedRoomId && stateKey
        ? await getStateEventForTransition(db, typedRoomId, "m.room.member", stateKey)
        : null,
    roomState: typedRoomId ? await getRoomStateForTransition(db, typedRoomId) : [],
    inviteStrippedState: typedRoomId
      ? await getInviteStrippedStateForTransition(db, typedRoomId)
      : [],
  };
}

export async function persistMembershipTransitionResult(
  db: D1Database,
  input: {
    roomId: string;
    event: PDU;
    result: MembershipTransitionResult;
  },
): Promise<void> {
  const stateKey = input.event.state_key;
  if (!stateKey) {
    return;
  }

  if (input.result.membershipToPersist) {
    const memberContent = input.event.content as { displayname?: string; avatar_url?: string };
    const typedRoomId = toRoomId(input.roomId);
    const typedUserId = toUserId(stateKey);
    const typedEventId = toEventId(input.event.event_id);
    if (!typedRoomId || !typedUserId || !typedEventId) {
      return;
    }

    await updateMembershipForTransition(
      db,
      typedRoomId,
      typedUserId,
      input.result.membershipToPersist,
      typedEventId,
      memberContent.displayname,
      memberContent.avatar_url,
    );
  }

  if (input.result.shouldUpsertRoomState) {
    await upsertMembershipTransitionRoomState(
      db,
      input.roomId,
      input.event.type,
      stateKey,
      input.event.event_id,
    );
  }

  if (input.result.shouldUpsertKnockState) {
    await upsertMembershipTransitionKnockRecord(db, input.roomId, stateKey, input.event);
  } else if (input.result.shouldClearKnockState) {
    await clearMembershipTransitionKnockRecord(db, input.roomId, stateKey);
  }
}
