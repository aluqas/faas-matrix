import {
  clearDeferredAuthMarkerForEvent,
  deleteRoomStateEvent,
  getDeferredPartialStateAuthEventsForRoom,
  getEvent,
  getRoomState,
  rejectProcessedPdu,
  setRoomStateEvent,
  storeEvent,
  updateMembership,
} from "../../../infra/db/database";
import { checkEventAuth } from "../../../infra/db/event-auth";
import {
  ensureFederatedRoomStubRecord,
  federationEventExists,
  getEffectiveMembershipForRealtimeUser,
  getFederationRoomVersion,
  listFederationMembershipStatePointers,
  loadFederationStateBundleFromRepository,
  persistInviteStrippedStateRecords,
  upsertFederatedRoomState,
} from "../../../infra/repositories/federation-state-repository";
import type { Membership, PDU } from "../../../shared/types";
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

export interface FederationStateBundle {
  state: PDU[];
  authChain: PDU[];
  roomState: PDU[];
  serversInRoom: string[];
}

export function loadFederationStateBundle(
  db: D1Database,
  roomId: string,
): Promise<FederationStateBundle> {
  return loadFederationStateBundleFromRepository(db, roomId);
}

export async function persistFederationMembershipEvent(
  db: D1Database,
  input: {
    roomId: string;
    event: PDU;
    source?: MembershipTransitionSource;
  },
): Promise<void> {
  const existing = await federationEventExists(db, input.event.event_id);
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
  const stateRows = await listFederationMembershipStatePointers(db, roomId);

  let restored = 0;
  for (const row of stateRows) {
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
    await upsertFederatedRoomState(db, roomId, "m.room.member", row.state_key, previousEventId);
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

  const roomVersion = await getFederationRoomVersion(db, roomId);

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
  await persistInviteStrippedStateRecords(db, roomId, strippedStateEvents);
}

export async function ensureFederatedRoomStub(
  db: D1Database,
  roomId: string,
  roomVersion: string,
  creatorId: string,
): Promise<void> {
  await ensureFederatedRoomStubRecord(db, roomId, roomVersion, creatorId);
}

async function upsertRoomState(db: D1Database, roomId: string, event: PDU): Promise<void> {
  if (event.state_key === undefined) {
    return;
  }

  await upsertFederatedRoomState(db, roomId, event.type, event.state_key, event.event_id);
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
    if (!(await federationEventExists(db, normalizedEvent.event_id))) {
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

    if (!(await federationEventExists(db, normalizedEvent.event_id))) {
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
    getMembership(roomId: string, userId: string) {
      return getEffectiveMembershipForRealtimeUser(db, roomId, userId);
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

        const membership = await getEffectiveMembershipForRealtimeUser(db, roomId, userId);
        if (membership !== "join" && !partialStateRoom) {
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
