import type { AppContext } from "../../../../foundation/app-context";
import type { SignedTransport } from "../../../../fedcore/contracts";
import { verifyRemoteSignature } from "../../../../services/federation-keys";
import { federationGet, federationPost } from "../../../../services/federation-keys";
import { resolveState } from "../../../../services/state-resolution";
import { getDefaultRoomVersion, getRoomVersion } from "../../../../services/room-versions";
import type { PDU, RoomMemberContent } from "../../../../types";
import {
  calculateContentHash,
  calculateReferenceHashEventId,
  calculateReferenceHashEventIdStandard,
  verifyContentHash,
} from "../../../../utils/crypto";
import { extractServerNameFromMatrixId } from "../../../../utils/matrix-ids";
import { fanoutEventToRemoteServers } from "../../../../services/federation-fanout";
import type { FederationRepository } from "../../../repositories/interfaces";
import { createServerAclPolicy } from "../server-acl/policy";
import { emitEffectWarning } from "../../effect-debug";
import { runFederationEffect } from "../../effect-runtime";
import { withLogContext } from "../../logging";
import {
  MembershipTransitionService,
  resolveMembershipAuthState,
} from "../../membership-transition-service";
import { checkEventAuth } from "../../../../services/event-auth";
import { getPartialStateJoinForRoom } from "../partial-state/tracker";
import {
  findInvalidCanonicalJsonNumberPath,
  roomVersionRequiresIntegerJsonNumbers,
} from "../../pdu-validator";
import { markPartialStateDeferredMembershipEvent } from "./partial-state-membership";
import {
  extractRawFederationPduFields,
  toRawFederationPdu,
  type FederationTransactionEnvelope,
  type FederationTransactionResult,
  type PduIngestInput,
  type PduIngestResult,
} from "./contracts";

type StructuredLogger = ReturnType<typeof withLogContext>;

const membershipTransitions = new MembershipTransitionService();

export interface PduIngestPorts {
  appContext: AppContext;
  repository: FederationRepository;
  signedTransport: SignedTransport;
  processTransaction: (
    input: FederationTransactionEnvelope,
  ) => Promise<FederationTransactionResult>;
}

const PARTIAL_STATE_DEFERRED_MEMBERSHIP_AUTH_ERRORS = new Set([
  "Sender is not joined to the room",
  "Sender must be joined to kick",
  "Only the original inviter can rescind an invite",
  "Insufficient power level to invite",
  "Insufficient power level to kick",
  "Cannot kick user with equal or higher power",
  "Insufficient power level to ban",
  "Cannot ban user with equal or higher power",
  "Insufficient power level to unban",
]);

export function shouldDeferPartialStateMembershipAuthFailure(
  event: Pick<PDU, "type" | "sender" | "state_key" | "content">,
  errorMessage: string | undefined,
): boolean {
  if (event.type !== "m.room.member" || typeof errorMessage !== "string") {
    return false;
  }

  if (PARTIAL_STATE_DEFERRED_MEMBERSHIP_AUTH_ERRORS.has(errorMessage)) {
    return true;
  }

  const membership =
    event.content &&
    typeof event.content === "object" &&
    !Array.isArray(event.content) &&
    typeof (event.content as RoomMemberContent).membership === "string"
      ? (event.content as RoomMemberContent).membership
      : undefined;

  return (
    errorMessage === "Not a member of the room" &&
    membership === "leave" &&
    event.sender === event.state_key
  );
}

function isD1Database(value: unknown): value is D1Database {
  return (
    typeof value === "object" &&
    value !== null &&
    "prepare" in value &&
    typeof (value as { prepare?: unknown }).prepare === "function"
  );
}

function hasRelationContent(pdu: PDU): boolean {
  const content = pdu.content;
  if (!content || typeof content !== "object" || Array.isArray(content)) {
    return false;
  }

  const record = content as Record<string, unknown>;
  const relation = record["m.relates_to"] ?? record["m.relationship"];
  return !!relation && typeof relation === "object" && !Array.isArray(relation);
}

async function validateAuthEventDependencies(
  repository: FederationRepository,
  pdu: PDU,
): Promise<string | null> {
  for (const authEventId of pdu.auth_events ?? []) {
    const processed = await repository.getProcessedPdu(authEventId);
    if (processed && !processed.accepted) {
      return `Auth event ${authEventId} was rejected`;
    }

    const existing = await repository.getEvent(authEventId);
    if (!existing) {
      return `Missing auth event ${authEventId}`;
    }
  }

  return null;
}

async function fetchStateSnapshotForMissingPrevEvent(
  ports: PduIngestPorts,
  origin: string,
  roomId: string,
  prevEventId: string,
  logger: StructuredLogger,
): Promise<boolean> {
  const stateIdsResponse = await federationGet(
    origin,
    `/_matrix/federation/v1/state_ids/${encodeURIComponent(roomId)}?event_id=${encodeURIComponent(prevEventId)}`,
    ports.appContext.capabilities.config.serverName,
    ports.appContext.capabilities.sql.connection as D1Database,
    ports.appContext.capabilities.kv.cache as KVNamespace,
  );

  if (!stateIdsResponse.ok) {
    await runFederationEffect(
      logger.warn("federation.pdu.state_snapshot_error", {
        room_id: roomId,
        event_id: prevEventId,
        error_message: `state_ids returned ${stateIdsResponse.status}`,
      }),
    );
    return true;
  }

  const stateIds = (await stateIdsResponse.json()) as {
    pdu_ids?: unknown[];
    auth_chain_ids?: unknown[];
  };
  const snapshotEventIds = Array.from(
    new Set(
      [
        ...(Array.isArray(stateIds.pdu_ids) ? stateIds.pdu_ids : []),
        ...(Array.isArray(stateIds.auth_chain_ids) ? stateIds.auth_chain_ids : []),
      ].filter((eventId): eventId is string => typeof eventId === "string"),
    ),
  );

  const missingSnapshotEventIds: string[] = [];
  for (const eventId of snapshotEventIds) {
    const existing = await ports.repository.getEvent(eventId);
    const processed = await ports.repository.getProcessedPdu(eventId);
    if (!existing && !processed) {
      missingSnapshotEventIds.push(eventId);
    }
  }

  for (const eventId of missingSnapshotEventIds) {
    const eventResponse = await federationGet(
      origin,
      `/_matrix/federation/v1/event/${encodeURIComponent(eventId)}`,
      ports.appContext.capabilities.config.serverName,
      ports.appContext.capabilities.sql.connection as D1Database,
      ports.appContext.capabilities.kv.cache as KVNamespace,
    );

    if (!eventResponse.ok) {
      await runFederationEffect(
        logger.warn("federation.pdu.state_snapshot_event_missing", {
          room_id: roomId,
          event_id: eventId,
          error_message: `event returned ${eventResponse.status}`,
        }),
      );
      continue;
    }

    await runFederationEffect(
      logger.info("federation.pdu.state_snapshot_event_seen", {
        room_id: roomId,
        event_id: eventId,
      }),
    );
  }

  await runFederationEffect(
    logger.info("federation.pdu.state_snapshot_result", {
      room_id: roomId,
      event_id: prevEventId,
      state_event_count: Array.isArray(stateIds.pdu_ids) ? stateIds.pdu_ids.length : 0,
      auth_chain_event_count: Array.isArray(stateIds.auth_chain_ids)
        ? stateIds.auth_chain_ids.length
        : 0,
      missing_snapshot_event_count: missingSnapshotEventIds.length,
    }),
  );
  return missingSnapshotEventIds.length > 0;
}

async function fetchMissingAuthEventsIfNeeded(
  ports: PduIngestPorts,
  origin: string,
  txnId: string,
  roomId: string,
  pdu: PDU,
  logger: StructuredLogger,
): Promise<void> {
  const authEvents = pdu.auth_events ?? [];
  if (authEvents.length === 0) {
    return;
  }

  const missingAuthEvents: string[] = [];
  for (const authEventId of authEvents) {
    const existing = await ports.repository.getEvent(authEventId);
    const processed = await ports.repository.getProcessedPdu(authEventId);
    if (!existing && !processed) {
      missingAuthEvents.push(authEventId);
    }
  }

  if (missingAuthEvents.length === 0) {
    return;
  }

  const response = await federationGet(
    origin,
    `/_matrix/federation/v1/event_auth/${encodeURIComponent(roomId)}/${encodeURIComponent(pdu.event_id)}`,
    ports.appContext.capabilities.config.serverName,
    ports.appContext.capabilities.sql.connection as D1Database,
    ports.appContext.capabilities.kv.cache as KVNamespace,
  );

  if (!response.ok) {
    await runFederationEffect(
      logger.warn("federation.pdu.auth_chain_error", {
        room_id: roomId,
        event_id: pdu.event_id,
        error_message: `event_auth returned ${response.status}`,
      }),
    );
    return;
  }

  const data = (await response.json()) as {
    auth_chain?: unknown[];
    auth_events?: unknown[];
  };
  const rawAuthEvents = (Array.isArray(data.auth_chain) ? data.auth_chain : data.auth_events) ?? [];
  const authPdus = rawAuthEvents.filter(
    (event): event is Record<string, unknown> =>
      event !== null && typeof event === "object" && !Array.isArray(event),
  );

  if (authPdus.length === 0) {
    return;
  }

  await ports.processTransaction({
    origin,
    txnId: `${txnId}:auth:${pdu.event_id}`,
    body: {
      pdus: authPdus,
      edus: [],
    },
    disableGapFill: true,
    historicalOnly: true,
  });

  await runFederationEffect(
    logger.info("federation.pdu.auth_chain_result", {
      room_id: roomId,
      event_id: pdu.event_id,
      fetched_event_count: authPdus.length,
    }),
  );
}

async function fetchMissingPrevEventsIfNeeded(
  ports: PduIngestPorts,
  origin: string,
  txnId: string,
  roomId: string,
  roomVersion: string,
  pdu: PDU,
  logger: StructuredLogger,
  disableGapFill: boolean,
): Promise<boolean> {
  if (hasRelationContent(pdu)) {
    return false;
  }

  const partialStateJoin = await getPartialStateJoinForRoom(
    ports.appContext.capabilities.kv.cache as KVNamespace | undefined,
    roomId,
  );
  if (partialStateJoin) {
    return false;
  }

  const prevEvents = pdu.prev_events ?? [];
  if (prevEvents.length === 0) {
    return false;
  }

  const missingPrevEvents: string[] = [];
  for (const prevEventId of prevEvents) {
    const existing = await ports.repository.getEvent(prevEventId);
    const processed = await ports.repository.getProcessedPdu(prevEventId);
    if (!existing && !processed) {
      missingPrevEvents.push(prevEventId);
    }
  }

  if (missingPrevEvents.length === 0) {
    return false;
  }

  if (disableGapFill) {
    const firstMissingPrevEventId = missingPrevEvents[0];
    if (!firstMissingPrevEventId) {
      return false;
    }
    return fetchStateSnapshotForMissingPrevEvent(
      ports,
      origin,
      roomId,
      firstMissingPrevEventId,
      logger,
    );
  }

  const latestKnownEvents = await ports.repository.getLatestRoomEvents(roomId, 1);
  const earliestKnownEvent = latestKnownEvents[0];
  const earliestEventId = earliestKnownEvent?.event_id;
  if (!earliestEventId) {
    return false;
  }

  await runFederationEffect(
    logger.info("federation.pdu.gap_fill_start", {
      room_id: roomId,
      event_id: pdu.event_id,
      room_version: roomVersion,
      earliest_event_count: 1,
      earliest_event_id: earliestEventId,
      earliest_event_type: earliestKnownEvent.type,
      earliest_event_sender: earliestKnownEvent.sender,
      earliest_event_state_key: earliestKnownEvent.state_key,
      earliest_event_depth: earliestKnownEvent.depth,
      missing_prev_event_count: missingPrevEvents.length,
    }),
  );
  await emitEffectWarning("[federation.pdu] gap fill boundary", {
    roomId,
    incomingEventId: pdu.event_id,
    earliestEventId,
    earliestEventType: earliestKnownEvent.type,
    earliestEventSender: earliestKnownEvent.sender,
    earliestEventStateKey: earliestKnownEvent.state_key,
    earliestEventDepth: earliestKnownEvent.depth,
  });

  const response = await federationPost(
    origin,
    `/_matrix/federation/v1/get_missing_events/${encodeURIComponent(roomId)}`,
    {
      limit: 20,
      earliest_events: [earliestEventId],
      latest_events: [pdu.event_id],
    },
    ports.appContext.capabilities.config.serverName,
    ports.appContext.capabilities.sql.connection as D1Database,
    ports.appContext.capabilities.kv.cache as KVNamespace,
  );

  if (!response.ok) {
    await runFederationEffect(
      logger.warn("federation.pdu.gap_fill_error", {
        room_id: roomId,
        event_id: pdu.event_id,
        error_message: `get_missing_events returned ${response.status}`,
      }),
    );
    return false;
  }

  const data = (await response.json()) as { events?: unknown[] };
  const rawEvents = Array.isArray(data.events)
    ? data.events.filter(
        (event): event is Record<string, unknown> =>
          event !== null && typeof event === "object" && !Array.isArray(event),
      )
    : [];

  if (rawEvents.length === 0) {
    return false;
  }

  const missingEventsResult = await ports.processTransaction({
    origin,
    txnId: `${txnId}:missing:${pdu.event_id}`,
    body: { pdus: rawEvents, edus: [] },
    disableGapFill: true,
  });

  for (const fetchedEventId of Object.keys(missingEventsResult.pdus)) {
    const processed = await ports.repository.getProcessedPdu(fetchedEventId);
    if (processed && !processed.accepted) {
      return true;
    }
  }

  await runFederationEffect(
    logger.info("federation.pdu.gap_fill_result", {
      room_id: roomId,
      event_id: pdu.event_id,
      fetched_event_count: rawEvents.length,
    }),
  );
  return false;
}

async function storeAcceptedPdu(
  ports: PduIngestPorts,
  pdu: PDU,
  options?: {
    deferredPartialStateMembershipAuthReason?: string | null;
  },
): Promise<void> {
  const existingRoom = await ports.repository.getRoom(pdu.room_id);
  const priorRoomState =
    pdu.type === "m.room.member" && pdu.state_key
      ? await ports.repository.getRoomState(pdu.room_id)
      : [];
  const priorInviteStrippedState =
    pdu.type === "m.room.member" && pdu.state_key
      ? await ports.repository.getInviteStrippedState(pdu.room_id)
      : [];
  if (!existingRoom) {
    const content = pdu.content as { room_version?: string; creator?: string };
    const roomVersion = pdu.type === "m.room.create" ? content.room_version || "10" : "10";
    await ports.repository.createRoom(
      pdu.room_id,
      roomVersion,
      content.creator || pdu.sender || "",
      false,
    );
  }

  if (pdu.type === "m.room.member" && pdu.state_key) {
    const currentMemberEvent =
      resolveMembershipAuthState(pdu.room_id, priorRoomState, priorInviteStrippedState).find(
        (event) => event.type === "m.room.member" && event.state_key === pdu.state_key,
      ) ?? null;
    const storedPdu = options?.deferredPartialStateMembershipAuthReason
      ? markPartialStateDeferredMembershipEvent(pdu, {
          reason: options.deferredPartialStateMembershipAuthReason,
          previousEvent: currentMemberEvent,
        })
      : pdu;
    await ports.repository.storeIncomingEvent(storedPdu);
    const result = membershipTransitions.evaluate({
      event: storedPdu,
      roomId: pdu.room_id,
      source: "federation",
      currentMembership: currentMemberEvent
        ? {
            membership: (currentMemberEvent.content as RoomMemberContent).membership ?? "leave",
            eventId: currentMemberEvent.event_id,
          }
        : null,
      currentMemberEvent,
      roomState: priorRoomState,
      inviteStrippedState: priorInviteStrippedState,
    });
    if (result.membershipToPersist) {
      const memberContent = storedPdu.content as { displayname?: string; avatar_url?: string };
      await ports.repository.updateMembership(
        storedPdu.room_id,
        storedPdu.state_key!,
        result.membershipToPersist,
        storedPdu.event_id,
        memberContent.displayname,
        memberContent.avatar_url,
      );
    }
  } else {
    await ports.repository.storeIncomingEvent(pdu);
  }

  await ports.repository.notifyUsersOfEvent(pdu.room_id, pdu.event_id, pdu.type);
  if (pdu.state_key === undefined) {
    return;
  }

  const prevEvents = pdu.prev_events || [];
  if (prevEvents.length > 1) {
    try {
      const currentState = await ports.repository.getRoomState(pdu.room_id);
      const resolved = resolveState(existingRoom?.room_version || "10", [currentState, [pdu]]);
      for (const stateEvent of resolved) {
        if (stateEvent.state_key !== undefined) {
          await ports.repository.upsertRoomState(
            pdu.room_id,
            stateEvent.type,
            stateEvent.state_key,
            stateEvent.event_id,
          );
        }
      }
      return;
    } catch {
      // Fall through to direct replacement.
    }
  }

  await ports.repository.upsertRoomState(pdu.room_id, pdu.type, pdu.state_key, pdu.event_id);
}

export async function ingestFederationPdu(
  ports: PduIngestPorts,
  input: PduIngestInput,
  logger: StructuredLogger,
): Promise<PduIngestResult> {
  const pdu = toRawFederationPdu(input.rawPdu);
  const {
    roomId,
    sender,
    eventType,
    content,
    eventId: incomingEventId,
  } = extractRawFederationPduFields(pdu);

  if (!roomId || !sender || !eventType || !content) {
    return {
      kind: "rejected",
      eventId: incomingEventId ?? "unknown",
      reason: "Invalid PDU structure",
      requiresRefanout: false,
    };
  }

  const room = await ports.repository.getRoom(roomId);
  const roomVersion =
    room?.room_version ||
    (eventType === "m.room.create" && typeof content["room_version"] === "string"
      ? content["room_version"]
      : getDefaultRoomVersion());
  const eventIdFormat = getRoomVersion(roomVersion)?.eventIdFormat ?? "v4";
  const urlsafeEventId =
    eventIdFormat === "v1"
      ? (incomingEventId ?? null)
      : await calculateReferenceHashEventId(input.rawPdu, roomVersion);
  const standardEventId =
    eventIdFormat === "v1"
      ? (incomingEventId ?? null)
      : await calculateReferenceHashEventIdStandard(input.rawPdu, roomVersion);
  const normalizedEventId = eventIdFormat === "v1" ? (incomingEventId ?? null) : urlsafeEventId;
  const eventId = normalizedEventId || incomingEventId || "unknown";
  if (!normalizedEventId) {
    return {
      kind: "rejected",
      eventId,
      reason: "Invalid PDU structure",
      requiresRefanout: false,
    };
  }

  if (roomVersionRequiresIntegerJsonNumbers(roomVersion)) {
    const invalidNumberPath = findInvalidCanonicalJsonNumberPath(input.rawPdu);
    if (invalidNumberPath) {
      const reason = `Invalid canonical JSON number at ${invalidNumberPath}`;
      await ports.repository.recordProcessedPdu(eventId, input.origin, roomId, false, reason);
      return {
        kind: "rejected",
        eventId,
        reason,
        requiresRefanout: false,
      };
    }
  }

  if (eventIdFormat !== "v1") {
    await emitEffectWarning("[federation.pdu] normalized inbound", {
      origin: input.origin,
      roomId,
      roomVersion,
      eventType,
      stateKey: typeof pdu.state_key === "string" ? pdu.state_key : undefined,
      incomingEventId,
      urlsafeEventId,
      standardEventId,
      normalizedEventId,
    });
  }

  const normalizedPdu = {
    ...input.rawPdu,
    room_id: roomId,
    sender,
    type: eventType,
    content,
    event_id: normalizedEventId,
  } as PDU;
  let snapshotIncomplete = false;
  let deferredPartialStateMembershipAuthReason: string | null = null;

  if (room) {
    snapshotIncomplete = await fetchMissingPrevEventsIfNeeded(
      ports,
      input.origin,
      input.txnId,
      roomId,
      room.room_version,
      normalizedPdu,
      logger,
      input.disableGapFill ?? false,
    );
    await fetchMissingAuthEventsIfNeeded(
      ports,
      input.origin,
      input.txnId,
      roomId,
      normalizedPdu,
      logger,
    );
  }

  const existingPdu = await ports.repository.getProcessedPdu(normalizedEventId);
  if (existingPdu) {
    return existingPdu.accepted
      ? {
          kind: "ignored",
          eventId,
          requiresRefanout: false,
        }
      : {
          kind: "rejected",
          eventId,
          reason: existingPdu.rejectionReason || "Previously rejected",
          requiresRefanout: false,
        };
  }

  const pduOrigin = extractServerNameFromMatrixId(sender);
  if (!pduOrigin) {
    return {
      kind: "rejected",
      eventId,
      reason: "Invalid sender format",
      requiresRefanout: false,
    };
  }

  if (snapshotIncomplete && !input.historicalOnly) {
    const reason = "Missing prev events could not be resolved";
    await ports.repository.recordProcessedPdu(eventId, pduOrigin, roomId, false, reason);
    return {
      kind: "soft_failed",
      eventId,
      reason,
      requiresRefanout: false,
    };
  }

  if (normalizedPdu.signatures) {
    let signatureValid = false;
    const cache = ports.appContext.capabilities.kv.cache as KVNamespace;
    const signatureCandidate = input.rawPdu as Record<string, unknown>;
    const signatories = Object.keys(normalizedPdu.signatures);
    for (const signatory of signatories) {
      const signaturesForSignatory = normalizedPdu.signatures[signatory];
      if (!signaturesForSignatory) {
        continue;
      }
      const keyIds = Object.keys(signaturesForSignatory);
      for (const keyId of keyIds) {
        try {
          const validByService = await verifyRemoteSignature(
            signatureCandidate,
            signatory,
            keyId,
            ports.appContext.capabilities.sql.connection as D1Database,
            cache,
          );
          const validByTransport = await ports.signedTransport.verifyJson(
            signatureCandidate,
            signatory,
            keyId,
          );
          if (validByService || validByTransport) {
            signatureValid = true;
            break;
          }
        } catch {
          continue;
        }
      }
      if (signatureValid) {
        break;
      }
    }

    if (!signatureValid && pduOrigin !== input.origin) {
      await ports.repository.recordProcessedPdu(
        eventId,
        pduOrigin,
        roomId,
        false,
        "Invalid signature",
      );
      return {
        kind: "rejected",
        eventId,
        reason: "Invalid signature",
        requiresRefanout: false,
      };
    }
  }

  if (normalizedPdu.hashes?.sha256) {
    const contentHashInput =
      eventIdFormat === "v1"
        ? normalizedPdu
        : ({ ...normalizedPdu, event_id: undefined } as unknown as Record<string, unknown>);
    const hashValid = await verifyContentHash(
      contentHashInput as unknown as Record<string, unknown>,
      normalizedPdu.hashes.sha256,
    );
    if (!hashValid) {
      const rawHash = await calculateContentHash(input.rawPdu);
      const normalizedHash = await calculateContentHash(
        normalizedPdu as unknown as Record<string, unknown>,
      );
      const withoutEventIdHash = await calculateContentHash({
        ...normalizedPdu,
        event_id: undefined,
      } as unknown as Record<string, unknown>);
      await emitEffectWarning("[federation.pdu] content hash mismatch", {
        origin: input.origin,
        roomId,
        roomVersion,
        eventId,
        eventType: normalizedPdu.type,
        hadIncomingEventId: typeof input.rawPdu["event_id"] === "string",
        expectedHash: normalizedPdu.hashes.sha256,
        rawHash,
        normalizedHash,
        withoutEventIdHash,
        rawKeys: Object.keys(input.rawPdu).sort(),
        unsignedKeys:
          input.rawPdu["unsigned"] &&
          typeof input.rawPdu["unsigned"] === "object" &&
          !Array.isArray(input.rawPdu["unsigned"])
            ? Object.keys(input.rawPdu["unsigned"] as Record<string, unknown>).sort()
            : [],
      });
      await ports.repository.recordProcessedPdu(
        eventId,
        pduOrigin,
        roomId,
        false,
        "Content hash mismatch",
      );
      return {
        kind: "rejected",
        eventId,
        reason: "Content hash mismatch",
        requiresRefanout: false,
      };
    }
  }

  if (room) {
    const authDependencyError = await validateAuthEventDependencies(
      ports.repository,
      normalizedPdu,
    );
    if (authDependencyError) {
      if (
        !input.historicalOnly &&
        snapshotIncomplete &&
        authDependencyError.startsWith("Missing auth event ")
      ) {
        await runFederationEffect(
          logger.warn("federation.pdu.soft_failed", {
            room_id: roomId,
            event_id: eventId,
            event_type: normalizedPdu.type,
            error_message: authDependencyError,
          }),
        );
        await ports.repository.recordProcessedPdu(
          eventId,
          pduOrigin,
          roomId,
          false,
          authDependencyError,
        );
        return {
          kind: "soft_failed",
          eventId,
          reason: authDependencyError,
          requiresRefanout: false,
        };
      }
      await emitEffectWarning("[federation.pdu] rejected", {
        roomId,
        eventId,
        type: normalizedPdu.type,
        sender: normalizedPdu.sender,
        stateKey: normalizedPdu.state_key,
        reason: authDependencyError,
      });
      await ports.repository.recordProcessedPdu(
        eventId,
        pduOrigin,
        roomId,
        false,
        authDependencyError,
      );
      return {
        kind: "rejected",
        eventId,
        reason: authDependencyError,
        requiresRefanout: false,
      };
    }
  }

  if (room && !input.historicalOnly) {
    const aclPolicy = createServerAclPolicy(await ports.repository.getRoomState(roomId));
    const aclDecision = aclPolicy.allowPdu(input.origin, roomId, normalizedPdu);
    if (aclDecision.kind === "deny") {
      await emitEffectWarning("[federation.pdu] ACL rejected", {
        origin: input.origin,
        roomId,
        eventId,
        eventType: normalizedPdu.type,
        reason: aclDecision.reason,
      });
      await ports.repository.recordProcessedPdu(
        eventId,
        pduOrigin,
        roomId,
        false,
        aclDecision.reason,
      );
      return {
        kind: "rejected",
        eventId,
        reason: aclDecision.reason,
        requiresRefanout: false,
      };
    }

    try {
      let roomState = await ports.repository.getRoomState(roomId);
      const inviteStrippedState = await ports.repository.getInviteStrippedState(roomId);
      roomState = resolveMembershipAuthState(roomId, roomState, inviteStrippedState);
      const authResult = checkEventAuth(normalizedPdu, roomState, room.room_version);
      if (!authResult.allowed) {
        const partialStateJoin = await getPartialStateJoinForRoom(
          ports.appContext.capabilities.kv.cache as KVNamespace | undefined,
          roomId,
        );
        if (
          partialStateJoin &&
          ((authResult.error === "Sender is not joined to the room" &&
            normalizedPdu.type !== "m.room.member") ||
            shouldDeferPartialStateMembershipAuthFailure(normalizedPdu, authResult.error))
        ) {
          if (normalizedPdu.type === "m.room.member" && authResult.error) {
            deferredPartialStateMembershipAuthReason = authResult.error;
          }
          await runFederationEffect(
            logger.warn("federation.pdu.partial_state_auth_deferred", {
              room_id: roomId,
              event_id: eventId,
              event_type: normalizedPdu.type,
              reason: authResult.error,
            }),
          );
        } else {
          await emitEffectWarning("[federation.pdu] rejected", {
            roomId,
            eventId,
            type: normalizedPdu.type,
            sender: normalizedPdu.sender,
            stateKey: normalizedPdu.state_key,
            reason: authResult.error || "Auth failed",
          });
          await ports.repository.recordProcessedPdu(
            eventId,
            pduOrigin,
            roomId,
            false,
            authResult.error || "Auth failed",
          );
          return {
            kind: "rejected",
            eventId,
            reason: authResult.error || "Event authorization failed",
            requiresRefanout: false,
          };
        }
      }
    } catch {
      // Accept if auth evaluation itself fails.
    }
  }

  await ports.repository.recordProcessedPdu(normalizedEventId, pduOrigin, roomId, true);

  if (input.historicalOnly) {
    await ports.repository.storeIncomingEvent(normalizedPdu);
  } else {
    await storeAcceptedPdu(ports, normalizedPdu, {
      deferredPartialStateMembershipAuthReason,
    });
    const db = isD1Database(ports.appContext.capabilities.sql.connection)
      ? ports.appContext.capabilities.sql.connection
      : undefined;
    const cache = ports.appContext.capabilities.kv.cache as KVNamespace | undefined;
    if (db && cache && !deferredPartialStateMembershipAuthReason) {
      await fanoutEventToRemoteServers(
        db,
        cache,
        ports.appContext.capabilities.config.serverName,
        roomId,
        normalizedPdu,
        [input.origin],
      );
    }
  }

  return {
    kind: "accepted",
    eventId,
    requiresRefanout: false,
  };
}
