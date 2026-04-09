import {
  clearDeferredAuthMarkerForEvent,
  deleteRoomStateEvent,
  getDeferredPartialStateAuthEventsForRoom,
  getAuthChain,
  getEvent,
  getRoomState,
  rejectProcessedPdu,
  setRoomStateEvent,
  storeEvent,
  updateMembership,
} from "../../../infra/db/database";
import { checkEventAuth } from "../../../infra/db/event-auth";
import type { MatrixSignatures, Membership, PDU } from "../../../shared/types";
import { toEventId, toRoomId, toUserId } from "../../../shared/utils/ids";
import { extractServerNameFromMatrixId } from "../../../shared/utils/matrix-ids";
import type { FederationRepository } from "../../../infra/repositories/interfaces";
import type { RealtimeCapability } from "../../../shared/runtime/runtime-capabilities";
import {
  applyMembershipTransitionToDatabase,
  loadMembershipTransitionContext,
  type MembershipTransitionSource,
} from "../membership-transition-service";
import { EventQueryService, type MissingEventsQuery } from "./event-query-service";
import { tryValidateIncomingPdu } from "../pdu-validator";
import { ingestPresenceEdu } from "../../../features/presence/ingest";
import type { PresenceEduContent } from "../../../features/presence/contracts";
import { getPartialStateJoinForRoom } from "../../../features/partial-state/tracker";
import { ingestTypingEdu } from "../../../features/typing/ingest";
import type { TypingEduContent } from "../../../features/typing/contracts";
import { ingestDirectToDeviceEdu } from "../../../features/to-device/ingest";
import type { DirectToDeviceEduContent } from "../../../features/to-device/contracts";
import {
  getMembershipEventMembership,
  getPartialStateDeferredPreviousEventId,
  getPartialStateDeferredPreviousMembership,
  isPartialStateDeferredMembershipEvent,
} from "../../../features/federation-core/partial-state-membership";

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
    throw new TypeError("Stored event row contains invalid Matrix identifiers");
  }
  return {
    event_id: eventId,
    room_id: roomId,
    sender,
    type: row.event_type,
    state_key: row.state_key ?? undefined,
    content: parseJson<Record<string, unknown>>(row.content, {}) ?? {},
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
    unsigned: parseJson<Record<string, unknown> | undefined>(row.unsigned),
    hashes: parseJson<{ sha256: string } | undefined>(row.hashes),
    signatures: parseJson<MatrixSignatures | undefined>(row.signatures),
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

  const authChain = await getAuthChain(db, Array.from(authChainIds));

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

  if (!shouldApplyMembershipStateSnapshot(context.currentMemberEvent, input.event, input.source)) {
    return;
  }

  await applyMembershipTransitionToDatabase(db, {
    roomId: input.roomId,
    event: input.event,
    source: input.source ?? "federation",
    context,
  });
}

export function shouldApplyMembershipStateSnapshot(
  currentMembershipEvent:
    | Pick<PDU, "event_id" | "type" | "sender" | "state_key" | "content" | "unsigned">
    | null
    | undefined,
  incomingEvent: Pick<PDU, "event_id" | "type" | "content">,
  source: MembershipTransitionSource | undefined,
): boolean {
  if (source !== "workflow") {
    return true;
  }

  if (!currentMembershipEvent) {
    return true;
  }

  if (currentMembershipEvent.event_id === incomingEvent.event_id) {
    return true;
  }

  if (getMembershipEventMembership(incomingEvent) !== "join") {
    return false;
  }

  return isPartialStateDeferredMembershipEvent(currentMembershipEvent);
}

function isRestorableDeferredMembership(input: {
  currentEvent: PDU;
  previousMembership: Membership | null;
}): boolean {
  const currentMembership = getMembershipEventMembership(input.currentEvent);
  return (
    isPartialStateDeferredMembershipEvent(input.currentEvent) &&
    input.previousMembership === "join" &&
    (currentMembership === "leave" || currentMembership === "ban")
  );
}

export async function restoreDeferredPartialStateMemberships(
  db: D1Database,
  roomId: string,
): Promise<number> {
  const stateRows = await db
    .prepare(
      `SELECT state_key, event_id
       FROM room_state
       WHERE room_id = ? AND event_type = 'm.room.member'`,
    )
    .bind(roomId)
    .all<{ state_key: string; event_id: string }>();

  let restored = 0;
  for (const row of stateRows.results) {
    const currentEventId = toEventId(row.event_id);
    if (!currentEventId) {
      continue;
    }
    const currentEvent = await getEvent(db, currentEventId);
    if (!currentEvent) {
      continue;
    }

    const previousEventId = getPartialStateDeferredPreviousEventId(currentEvent);
    const previousMembership = getPartialStateDeferredPreviousMembership(currentEvent);
    if (
      !previousEventId ||
      !previousMembership ||
      !isRestorableDeferredMembership({ currentEvent, previousMembership })
    ) {
      continue;
    }

    const typedPreviousEventId = toEventId(previousEventId);
    if (!typedPreviousEventId) {
      continue;
    }
    const previousEvent = await getEvent(db, typedPreviousEventId);
    if (
      !previousEvent ||
      previousEvent.type !== "m.room.member" ||
      previousEvent.state_key !== row.state_key
    ) {
      continue;
    }

    const previousContent = previousEvent.content as { displayname?: string; avatar_url?: string };
    await db
      .prepare(
        `INSERT OR REPLACE INTO room_state (room_id, event_type, state_key, event_id)
         VALUES (?, 'm.room.member', ?, ?)`,
      )
      .bind(roomId, row.state_key, previousEventId)
      .run();
    await updateMembership(
      db,
      toRoomId(roomId),
      toUserId(row.state_key),
      previousMembership,
      typedPreviousEventId,
      previousContent.displayname,
      previousContent.avatar_url,
    );
    restored += 1;
  }

  return restored;
}

export async function reevaluateDeferredPartialStateAuthEvents(
  db: D1Database,
  roomId: string,
): Promise<void> {
  const typedRoomId = toRoomId(roomId);
  const deferredEvents = await getDeferredPartialStateAuthEventsForRoom(db, typedRoomId);
  if (deferredEvents.length === 0) return;

  const roomRow = await db
    .prepare(`SELECT room_version FROM rooms WHERE room_id = ?`)
    .bind(roomId)
    .first<{ room_version: string }>();
  const roomVersion = roomRow?.room_version ?? "10";

  const currentState = await getRoomState(db, typedRoomId);
  const currentStateMap = new Map(
    currentState.map((e) => [`${e.type}\0${e.state_key ?? ""}`, e.event_id]),
  );

  for (const event of deferredEvents) {
    const authResult = checkEventAuth(event, currentState, roomVersion);
    const stateMapKey = `${event.type}\0${event.state_key ?? ""}`;
    const currentStateEventId =
      event.state_key !== undefined ? currentStateMap.get(stateMapKey) : undefined;

    if (authResult.allowed) {
      await clearDeferredAuthMarkerForEvent(db, toEventId(event.event_id));
      if (event.state_key !== undefined && currentStateEventId !== event.event_id) {
        await setRoomStateEvent(
          db,
          typedRoomId,
          event.type,
          event.state_key,
          toEventId(event.event_id),
        );
      }
    } else {
      await rejectProcessedPdu(
        db,
        toEventId(event.event_id),
        authResult.error ?? "Auth failed after partial-state completion",
      );
      if (event.state_key !== undefined) {
        if (currentStateEventId === event.event_id) {
          const previousEventId = getPartialStateDeferredPreviousEventId(event);
          if (previousEventId) {
            await setRoomStateEvent(
              db,
              typedRoomId,
              event.type,
              event.state_key,
              toEventId(previousEventId),
            );
          } else {
            await deleteRoomStateEvent(db, typedRoomId, event.type, event.state_key);
          }
        }
      }
    }
  }
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
      await storeEvent(db, normalizedEvent, { skipRoomState: true });
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

export function getMissingFederationEvents(
  db: D1Database,
  query: MissingEventsQuery,
): Promise<PDU[]> {
  return eventQueryService.getMissingEvents(db, query);
}

export async function handleFederationPresenceEdu(
  repository: Pick<FederationRepository, "upsertPresence">,
  now: number,
  content: PresenceEduContent,
): Promise<void> {
  await ingestPresenceEdu(repository, now, content);
}

export async function handleFederationDeviceListEdu(
  repository: Pick<FederationRepository, "upsertRemoteDeviceList">,
  content: Record<string, unknown>,
): Promise<void> {
  const deviceUserId = typeof content.user_id === "string" ? toUserId(content.user_id) : undefined;
  const deviceId = typeof content.device_id === "string" ? content.device_id : undefined;
  if (!deviceUserId || !deviceId) {
    return;
  }

  await repository.upsertRemoteDeviceList(
    deviceUserId,
    deviceId,
    Number(content.stream_id ?? 0),
    (content.keys as Record<string, unknown> | undefined) ?? null,
    typeof content.device_display_name === "string" ? content.device_display_name : undefined,
    Boolean(content.deleted),
  );
}

export async function handleFederationTypingEdu(
  db: D1Database,
  origin: string,
  realtime: RealtimeCapability,
  cache: KVNamespace | undefined,
  content: TypingEduContent,
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
    async isPartialStateRoom(roomId: string) {
      const typedRoomId = toRoomId(roomId);
      if (!typedRoomId) {
        return false;
      }
      return (await getPartialStateJoinForRoom(cache, typedRoomId)) !== null;
    },
    async setRoomTyping(roomId: string, userId: string, typing: boolean, timeoutMs?: number) {
      const typedRoomId = toRoomId(roomId);
      const typedUserId = toUserId(userId);
      if (!typedRoomId || !typedUserId) {
        return;
      }
      await realtime.setRoomTyping?.(typedRoomId, typedUserId, typing, timeoutMs);
    },
  });
}

export async function handleFederationReceiptEdu(
  db: D1Database,
  origin: string,
  realtime: RealtimeCapability,
  cache: KVNamespace | undefined,
  content: Record<string, unknown>,
): Promise<void> {
  if (!realtime.setRoomReceipt) {
    return;
  }

  for (const [roomId, receiptsByType] of Object.entries(content)) {
    if (!receiptsByType || typeof receiptsByType !== "object" || Array.isArray(receiptsByType)) {
      continue;
    }

    const typedRoomId = toRoomId(roomId);
    const partialStateRoom = typedRoomId
      ? (await getPartialStateJoinForRoom(cache, typedRoomId)) !== null
      : false;
    for (const [receiptType, receiptsByUser] of Object.entries(receiptsByType)) {
      if (!receiptsByUser || typeof receiptsByUser !== "object" || Array.isArray(receiptsByUser)) {
        continue;
      }

      for (const [userId, receipt] of Object.entries(receiptsByUser)) {
        if (extractServerNameFromMatrixId(userId) !== origin) {
          continue;
        }
        if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
          continue;
        }

        const receiptRecord = receipt as Record<string, unknown>;
        const eventIds = Array.isArray(receiptRecord["event_ids"])
          ? receiptRecord["event_ids"].filter(
              (eventId): eventId is string => typeof eventId === "string",
            )
          : [];
        const eventId = eventIds[0];
        if (!eventId) {
          continue;
        }

        const membership = await db
          .prepare(
            `SELECT membership FROM room_memberships WHERE room_id = ? AND user_id = ? LIMIT 1`,
          )
          .bind(roomId, userId)
          .first<{ membership: string }>();
        if (membership?.membership !== "join" && !partialStateRoom) {
          continue;
        }

        const data =
          receiptRecord["data"] &&
          typeof receiptRecord["data"] === "object" &&
          !Array.isArray(receiptRecord["data"])
            ? (receiptRecord["data"] as Record<string, unknown>)
            : {};
        const ts = typeof data["ts"] === "number" ? data["ts"] : undefined;
        const typedUserId = toUserId(userId);
        const typedEventId = toEventId(eventId);
        if (!typedRoomId || !typedUserId || !typedEventId) {
          continue;
        }
        await realtime.setRoomReceipt(
          typedRoomId,
          typedUserId,
          typedEventId,
          receiptType,
          typeof data["thread_id"] === "string" ? data["thread_id"] : undefined,
          ts,
        );
      }
    }
  }
}

export async function handleFederationDirectToDeviceEdu(
  db: D1Database,
  origin: string,
  content: DirectToDeviceEduContent,
): Promise<void> {
  await ingestDirectToDeviceEdu(db, origin, content);
}
