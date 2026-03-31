import { storeEvent } from "../../services/database";
import type { PDU } from "../../types";
import { extractServerNameFromMatrixId } from "../../utils/matrix-ids";
import type { FederationRepository } from "../repositories/interfaces";
import type { RealtimeCapability } from "../../foundation/runtime-capabilities";
import {
  applyMembershipTransitionToDatabase,
  loadMembershipTransitionContext,
  type MembershipTransitionSource,
} from "./membership-transition-service";
import { EventQueryService, type MissingEventsQuery } from "./event-query-service";
import { tryValidateIncomingPdu } from "./pdu-validator";
import { ingestPresenceEdu } from "./features/presence/ingest";
import { ingestTypingEdu } from "./features/typing/ingest";
import { ingestDirectToDeviceEdu } from "./features/to-device/ingest";

type StoredEventRow = {
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
  unsigned?: string | null;
};

export interface FederationStateBundle {
  state: PDU[];
  authChain: PDU[];
  roomState: PDU[];
  serversInRoom: string[];
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
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
  return {
    event_id: row.event_id,
    room_id: row.room_id,
    sender: row.sender,
    type: row.event_type,
    state_key: row.state_key ?? undefined,
    content: parseJson<Record<string, unknown>>(row.content, {}),
    origin_server_ts: row.origin_server_ts,
    depth: row.depth,
    auth_events: parseJson<string[]>(row.auth_events, []),
    prev_events: parseJson<string[]>(row.prev_events, []),
    unsigned: parseJson<Record<string, unknown> | undefined>(row.unsigned, undefined),
    hashes: parseJson<{ sha256: string } | undefined>(row.hashes, undefined),
    signatures: parseJson<Record<string, Record<string, string>> | undefined>(
      row.signatures,
      undefined,
    ),
  };
}

async function loadCreateEventFallback(db: D1Database, roomId: string): Promise<PDU | null> {
  const createRow = await db
    .prepare(
      `SELECT event_id, room_id, sender, event_type, state_key, content, origin_server_ts, depth,
              auth_events, prev_events, hashes, signatures, unsigned
       FROM events
       WHERE room_id = ? AND event_type = 'm.room.create'
       LIMIT 1`,
    )
    .bind(roomId)
    .first<StoredEventRow>();

  return createRow ? rowToPdu(createRow) : null;
}

export async function loadFederationStateBundle(
  db: D1Database,
  roomId: string,
): Promise<FederationStateBundle> {
  const stateRows = await db
    .prepare(
      `SELECT e.event_id, e.room_id, e.sender, e.event_type, e.state_key, e.content,
              e.origin_server_ts, e.depth, e.auth_events, e.prev_events, e.hashes, e.signatures, e.unsigned
       FROM room_state rs
       JOIN events e ON rs.event_id = e.event_id
       WHERE rs.room_id = ?`,
    )
    .bind(roomId)
    .all<StoredEventRow>();

  const state = stateRows.results.map(rowToPdu);
  const roomState = [...state];
  if (!roomState.some((event) => event.type === "m.room.create")) {
    const createEvent = await loadCreateEventFallback(db, roomId);
    if (createEvent) {
      roomState.push(createEvent);
    }
  }

  const authChainIds = new Set<string>();
  for (const event of roomState) {
    for (const authEventId of event.auth_events) {
      authChainIds.add(authEventId);
    }
  }

  const authChain: PDU[] = [];
  for (const authEventId of authChainIds) {
    const authEvent = await db
      .prepare(
        `SELECT event_id, room_id, sender, event_type, state_key, content, origin_server_ts, depth,
                auth_events, prev_events, hashes, signatures, unsigned
         FROM events
         WHERE event_id = ?`,
      )
      .bind(authEventId)
      .first<StoredEventRow>();

    if (authEvent) {
      authChain.push(rowToPdu(authEvent));
    }
  }

  const serversInRoom = Array.from(
    new Set(
      roomState
        .filter((event) => event.type === "m.room.member" && event.content.membership === "join")
        .map((event) => extractServerNameFromMatrixId(event.sender))
        .filter((server): server is string => Boolean(server)),
    ),
  );

  return { state: roomState, authChain, roomState, serversInRoom };
}

export async function persistFederationMembershipEvent(
  db: D1Database,
  input: {
    roomId: string;
    event: PDU;
    source?: MembershipTransitionSource;
  },
): Promise<void> {
  const existing = await db
    .prepare(`SELECT event_id FROM events WHERE event_id = ?`)
    .bind(input.event.event_id)
    .first();
  const context = await loadMembershipTransitionContext(db, input.roomId, input.event.state_key);

  if (!existing) {
    await storeEvent(db, input.event);
  }

  await applyMembershipTransitionToDatabase(db, {
    roomId: input.roomId,
    event: input.event,
    source: input.source ?? "federation",
    context,
  });
}

export async function persistInviteStrippedState(
  db: D1Database,
  roomId: string,
  strippedStateEvents: unknown[],
): Promise<void> {
  for (const event of strippedStateEvents) {
    if (!event || typeof event !== "object") {
      continue;
    }

    const record = event as Record<string, unknown>;
    if (typeof record.type !== "string" || typeof record.sender !== "string") {
      continue;
    }

    await db
      .prepare(
        `INSERT OR REPLACE INTO invite_stripped_state (room_id, event_type, state_key, content, sender)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(
        roomId,
        record.type,
        typeof record.state_key === "string" ? record.state_key : "",
        JSON.stringify(record.content && typeof record.content === "object" ? record.content : {}),
        record.sender,
      )
      .run();
  }
}

export async function ensureFederatedRoomStub(
  db: D1Database,
  roomId: string,
  roomVersion: string,
  creatorId: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO rooms (room_id, room_version, creator_id, is_public)
       VALUES (?, ?, ?, 0)`,
    )
    .bind(roomId, roomVersion, creatorId)
    .run();
}

async function upsertRoomState(db: D1Database, roomId: string, event: PDU): Promise<void> {
  if (event.state_key === undefined) {
    return;
  }

  await db
    .prepare(
      `INSERT OR REPLACE INTO room_state (room_id, event_type, state_key, event_id)
       VALUES (?, ?, ?, ?)`,
    )
    .bind(roomId, event.type, event.state_key, event.event_id)
    .run();
}

export async function persistFederationStateSnapshot(
  db: D1Database,
  input: {
    roomId: string;
    roomVersion: string;
    stateEvents: unknown[];
    authChain: unknown[];
    source?: MembershipTransitionSource;
  },
): Promise<void> {
  await ensureFederatedRoomStub(db, input.roomId, input.roomVersion, "");

  for (const rawEvent of input.authChain) {
    const event = await tryValidateIncomingPdu(rawEvent, "auth_chain", input.roomVersion);
    if (!event) {
      continue;
    }

    const normalizedEvent = {
      ...event,
      room_id: event.room_id || input.roomId,
    };
    const existing = await db
      .prepare(`SELECT event_id FROM events WHERE event_id = ?`)
      .bind(normalizedEvent.event_id)
      .first();

    if (!existing) {
      await storeEvent(db, normalizedEvent);
    }
  }

  for (const rawEvent of input.stateEvents) {
    const event = await tryValidateIncomingPdu(rawEvent, "state", input.roomVersion);
    if (!event) {
      continue;
    }

    const normalizedEvent = {
      ...event,
      room_id: event.room_id || input.roomId,
    };

    if (normalizedEvent.type === "m.room.member" && normalizedEvent.state_key !== undefined) {
      await persistFederationMembershipEvent(db, {
        roomId: input.roomId,
        event: normalizedEvent,
        source: input.source ?? "workflow",
      });
      continue;
    }

    const existing = await db
      .prepare(`SELECT event_id FROM events WHERE event_id = ?`)
      .bind(normalizedEvent.event_id)
      .first();
    if (!existing) {
      await storeEvent(db, normalizedEvent);
    }

    await upsertRoomState(db, input.roomId, normalizedEvent);
  }
}

const eventQueryService = new EventQueryService();

export async function getMissingFederationEvents(
  db: D1Database,
  query: MissingEventsQuery,
): Promise<PDU[]> {
  return eventQueryService.getMissingEvents(db, query);
}

export async function handleFederationPresenceEdu(
  repository: Pick<FederationRepository, "upsertPresence">,
  now: number,
  content: Record<string, unknown>,
): Promise<void> {
  await ingestPresenceEdu(repository, now, content);
}

export async function handleFederationDeviceListEdu(
  repository: Pick<FederationRepository, "upsertRemoteDeviceList">,
  content: Record<string, unknown>,
): Promise<void> {
  const deviceUserId = typeof content.user_id === "string" ? content.user_id : undefined;
  const deviceId = typeof content.device_id === "string" ? content.device_id : undefined;
  if (!deviceUserId || !deviceId) {
    return;
  }

  await repository.upsertRemoteDeviceList(
    deviceUserId,
    deviceId,
    Number(content.stream_id || 0),
    (content.keys as Record<string, unknown> | undefined) || null,
    typeof content.device_display_name === "string" ? content.device_display_name : undefined,
    Boolean(content.deleted),
  );
}

export async function handleFederationTypingEdu(
  db: D1Database,
  origin: string,
  realtime: RealtimeCapability,
  content: Record<string, unknown>,
): Promise<void> {
  if (!realtime.setRoomTyping) {
    return;
  }

  await ingestTypingEdu(origin, content, {
    async getMembership(roomId: string, userId: string) {
      const membership = await db
        .prepare(
          `SELECT membership FROM room_memberships WHERE room_id = ? AND user_id = ? LIMIT 1`,
        )
        .bind(roomId, userId)
        .first<{ membership: string }>();

      if (membership?.membership) {
        return membership.membership;
      }

      const stateMembership = await db
        .prepare(
          `SELECT json_extract(e.content, '$.membership') AS membership
           FROM room_state rs
           JOIN events e ON rs.event_id = e.event_id
           WHERE rs.room_id = ?
             AND rs.event_type = 'm.room.member'
             AND rs.state_key = ?
           LIMIT 1`,
        )
        .bind(roomId, userId)
        .first<{ membership: string | null }>();

      return stateMembership?.membership ?? null;
    },
    async setRoomTyping(roomId: string, userId: string, typing: boolean, timeoutMs?: number) {
      await realtime.setRoomTyping?.(roomId, userId, typing, timeoutMs);
    },
  });
}

export async function handleFederationDirectToDeviceEdu(
  db: D1Database,
  origin: string,
  content: Record<string, unknown>,
): Promise<void> {
  await ingestDirectToDeviceEdu(db, origin, content);
}
