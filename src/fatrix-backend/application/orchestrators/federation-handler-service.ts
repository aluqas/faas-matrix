import { Effect } from "effect";
import { checkEventAuth } from "../../../platform/cloudflare/adapters/db/event-auth";
import {
  clearDeferredFederationAuthMarker,
  deleteFederatedRoomState,
  ensureFederatedRoomStubRecord,
  federationEventExists,
  getDeferredFederationAuthEvents,
  getFederationRoomState,
  getFederationStoredEvent,
  getFederationRoomVersion,
  listFederationMembershipStatePointers,
  loadFederationStateBundleFromRepository,
  persistInviteStrippedStateRecords,
  rejectDeferredFederationAuthEvent,
  restoreFederationMembershipState,
  storeFederationEvent,
  upsertFederatedRoomState,
} from "../../../platform/cloudflare/adapters/repositories/federation-state-repository";
import type { Membership, PDU } from "../../../fatrix-model/types";
import { toEventId, toRoomId, toUserId } from "../../../fatrix-model/utils/ids";
import type { FederationRepository } from "../../ports/repositories";
import type { RealtimeCapability } from "../../ports/runtime/runtime-capabilities";
import {
  applyMembershipTransitionToDatabase,
  loadMembershipTransitionContext,
  type MembershipTransitionSource,
} from "../membership-transition-service";
import type { InfraError } from "../domain-error";
import { EventQueryService, type MissingEventsQuery } from "./event-query-service";
import { tryValidateIncomingPdu } from "../pdu-validator";
import { ingestPresenceEduEffect } from "../features/presence/ingest";
import type { PresenceEduContent } from "../features/presence/contracts";
import { createFederationTypingIngestPorts } from "../../../platform/cloudflare/adapters/application-ports/typing/effect-adapters";
import { ingestTypingEduEffect } from "../features/typing/ingest";
import type { TypingEduContent } from "../features/typing/contracts";
import { createFederationReceiptIngestPorts } from "../../../platform/cloudflare/adapters/application-ports/receipts/effect-adapters";
import { ingestReceiptEduEffect } from "../features/receipts/ingest";
import { ingestDirectToDeviceEdu } from "../../../platform/cloudflare/adapters/application-ports/to-device/ingest";
import type { DirectToDeviceEduContent } from "../features/to-device/contracts";
import { fromInfraPromise, fromInfraVoid } from "../effect/infra-effect";
import {
  getMembershipEventMembership,
  getPartialStateDeferredPreviousEventId,
  getPartialStateDeferredPreviousMembership,
  isPartialStateDeferredMembershipEvent,
} from "../federation/transactions/partial-state-membership";

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

export function loadFederationStateBundleEffect(
  db: D1Database,
  roomId: string,
): Effect.Effect<FederationStateBundle, InfraError> {
  return fromInfraPromise(
    () => loadFederationStateBundleFromRepository(db, roomId),
    "Failed to load federation state bundle",
  );
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
    await storeFederationEvent(db, input.event);
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

export function persistFederationMembershipEventEffect(
  db: D1Database,
  input: {
    roomId: string;
    event: PDU;
    source?: MembershipTransitionSource;
  },
): Effect.Effect<void, InfraError> {
  return fromInfraVoid(
    () => persistFederationMembershipEvent(db, input),
    "Failed to persist federation membership event",
  );
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
    const currentEvent = await getFederationStoredEvent(db, currentEventId);
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
    const previousEvent = await getFederationStoredEvent(db, typedPreviousEventId);
    if (
      !previousEvent ||
      previousEvent.type !== "m.room.member" ||
      previousEvent.state_key !== row.state_key
    ) {
      continue;
    }

    const typedRoomId = toRoomId(roomId);
    const typedUserId = toUserId(row.state_key);
    if (!typedRoomId || !typedUserId) {
      continue;
    }
    await restoreFederationMembershipState(db, {
      roomId: typedRoomId,
      userId: typedUserId,
      membership: previousMembership,
      event: previousEvent,
    });
    restored += 1;
  }

  return restored;
}

export function restoreDeferredPartialStateMembershipsEffect(
  db: D1Database,
  roomId: string,
): Effect.Effect<number, InfraError> {
  return fromInfraPromise(
    () => restoreDeferredPartialStateMemberships(db, roomId),
    "Failed to restore deferred partial-state memberships",
  );
}

export async function reevaluateDeferredPartialStateAuthEvents(
  db: D1Database,
  roomId: string,
): Promise<void> {
  const typedRoomId = toRoomId(roomId);
  if (!typedRoomId) {
    return;
  }

  const deferredEvents = await getDeferredFederationAuthEvents(db, typedRoomId);
  if (deferredEvents.length === 0) return;

  const roomVersion = await getFederationRoomVersion(db, roomId);

  const currentState = await getFederationRoomState(db, typedRoomId);
  const currentStateMap = new Map(
    currentState.map((e) => [`${e.type}\0${e.state_key ?? ""}`, e.event_id]),
  );

  for (const event of deferredEvents) {
    const authResult = checkEventAuth(event, currentState, roomVersion);
    const stateMapKey = `${event.type}\0${event.state_key ?? ""}`;
    const currentStateEventId =
      event.state_key !== undefined ? currentStateMap.get(stateMapKey) : undefined;

    if (authResult.allowed) {
      const typedEventId = toEventId(event.event_id);
      if (!typedEventId) {
        continue;
      }
      await clearDeferredFederationAuthMarker(db, typedEventId);
      if (event.state_key !== undefined && currentStateEventId !== event.event_id) {
        await upsertFederatedRoomState(db, typedRoomId, event.type, event.state_key, typedEventId);
      }
    } else {
      const typedEventId = toEventId(event.event_id);
      if (!typedEventId) {
        continue;
      }
      await rejectDeferredFederationAuthEvent(
        db,
        typedEventId,
        authResult.error ?? "Auth failed after partial-state completion",
      );
      if (event.state_key !== undefined && currentStateEventId === event.event_id) {
        const previousEventId = getPartialStateDeferredPreviousEventId(event);
        const typedPreviousEventId = previousEventId ? toEventId(previousEventId) : null;
        if (typedPreviousEventId) {
          await upsertFederatedRoomState(
            db,
            typedRoomId,
            event.type,
            event.state_key,
            typedPreviousEventId,
          );
        } else {
          await deleteFederatedRoomState(db, typedRoomId, event.type, event.state_key);
        }
      }
    }
  }
}

export function reevaluateDeferredPartialStateAuthEventsEffect(
  db: D1Database,
  roomId: string,
): Effect.Effect<void, InfraError> {
  return fromInfraVoid(
    () => reevaluateDeferredPartialStateAuthEvents(db, roomId),
    "Failed to reevaluate deferred partial-state auth events",
  );
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
      await storeFederationEvent(db, normalizedEvent, { skipRoomState: true });
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
      await storeFederationEvent(db, normalizedEvent);
    }

    await upsertRoomState(db, input.roomId, normalizedEvent);
  }
}

export function persistFederationStateSnapshotEffect(
  db: D1Database,
  input: {
    roomId: string;
    roomVersion: string;
    stateEvents: unknown[];
    authChain: unknown[];
    source?: MembershipTransitionSource;
  },
): Effect.Effect<void, InfraError> {
  return fromInfraVoid(
    () => persistFederationStateSnapshot(db, input),
    "Failed to persist federation state snapshot",
  );
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
  await Effect.runPromise(
    ingestPresenceEduEffect(
      {
        presenceStore: {
          upsertPresence: (userId, presence, statusMessage, lastActiveTs, currentlyActive) =>
            fromInfraVoid(
              () =>
                Promise.resolve(
                  repository.upsertPresence(
                    userId,
                    presence,
                    statusMessage,
                    lastActiveTs,
                    currentlyActive,
                  ),
                ),
              "Failed to apply presence EDU",
            ),
        },
      },
      now,
      content,
    ),
  );
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
  await Effect.runPromise(
    ingestTypingEduEffect(
      origin,
      content,
      createFederationTypingIngestPorts({
        db,
        realtime,
        cache,
      }),
    ),
  );
}

export async function handleFederationReceiptEdu(
  db: D1Database,
  origin: string,
  realtime: RealtimeCapability,
  cache: KVNamespace | undefined,
  content: Record<string, unknown>,
): Promise<void> {
  await Effect.runPromise(
    ingestReceiptEduEffect(
      createFederationReceiptIngestPorts({
        db,
        realtime,
        cache,
      }),
      { origin, content },
    ),
  );
}

export async function handleFederationDirectToDeviceEdu(
  db: D1Database,
  origin: string,
  content: DirectToDeviceEduContent,
): Promise<void> {
  await ingestDirectToDeviceEdu(db, origin, content);
}
