import type { AppContext } from "../../foundation/app-context";
import type {
  DeliveryQueue,
  DiscoveryService,
  RemoteKeyCache,
  SignedTransport,
} from "../../fedcore/contracts";
import { checkEventAuth } from "../../services/event-auth";
import { getDefaultRoomVersion, getRoomVersion } from "../../services/room-versions";
import { resolveState } from "../../services/state-resolution";
import type { PDU, RoomMemberContent } from "../../types";
import {
  calculateContentHash,
  calculateReferenceHashEventId,
  calculateReferenceHashEventIdStandard,
  sha256,
  verifyContentHash,
} from "../../utils/crypto";
import { verifyRemoteSignature } from "../../services/federation-keys";
import type { FederationRepository } from "../repositories/interfaces";
import { createServerAclPolicy } from "./features/server-acl/policy";
import { extractServerNameFromMatrixId } from "../../utils/matrix-ids";
import {
  handleFederationDeviceListEdu,
  handleFederationDirectToDeviceEdu,
  handleFederationPresenceEdu,
  handleFederationTypingEdu,
} from "./federation-handler-service";
import type { PresenceEduContent } from "./features/presence/contracts";
import type { TypingEduContent } from "./features/typing/contracts";
import type { DirectToDeviceEduContent } from "./features/to-device/contracts";
import {
  extractRawFederationPduFields,
  getRoomScopedEduRoomIds,
  toRawFederationEdu,
  toRawFederationPdu,
} from "./features/federation/contracts";
import {
  MembershipTransitionService,
  resolveMembershipAuthState,
} from "./membership-transition-service";
import { emitEffectWarning } from "./effect-debug";
import { runFederationEffect } from "./effect-runtime";
import { withLogContext } from "./logging";

export interface FederationTransactionInput {
  origin: string;
  txnId: string;
  body: {
    pdus?: Array<Record<string, unknown>>;
    edus?: Array<Record<string, unknown>>;
  };
}

interface CachedKeyRecord {
  keyId: string;
  key: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPresenceEduContent(
  content: Record<string, unknown>,
): content is Record<string, unknown> & PresenceEduContent {
  return Array.isArray(content["push"]);
}

function isTypingEduContent(
  content: Record<string, unknown>,
): content is Record<string, unknown> & TypingEduContent {
  return (
    typeof content["room_id"] === "string" &&
    typeof content["user_id"] === "string" &&
    typeof content["typing"] === "boolean"
  );
}

function isDirectToDeviceEduContent(
  content: Record<string, unknown>,
): content is Record<string, unknown> & DirectToDeviceEduContent {
  return (
    typeof content["sender"] === "string" &&
    typeof content["type"] === "string" &&
    typeof content["message_id"] === "string" &&
    isRecord(content["messages"])
  );
}

export class MatrixFederationService {
  private readonly membershipTransitions = new MembershipTransitionService();

  constructor(
    private readonly appContext: AppContext,
    private readonly repository: FederationRepository,
    private readonly signedTransport: SignedTransport,
    private readonly discoveryService: DiscoveryService,
    private readonly deliveryQueue: DeliveryQueue,
    private readonly remoteKeyCache: RemoteKeyCache<CachedKeyRecord>,
  ) {
    void this.appContext;
    void this.discoveryService;
    void this.deliveryQueue;
    void this.remoteKeyCache;
  }

  async processTransaction(
    input: FederationTransactionInput,
  ): Promise<{ pdus: Record<string, unknown> }> {
    const logger = withLogContext({
      component: "federation",
      operation: "transaction",
      origin: input.origin,
      txn_id: input.txnId,
      debugEnabled: this.appContext.profile.name === "complement",
    });
    await runFederationEffect(
      logger.info("federation.transaction.start", {
        pdu_count: input.body.pdus?.length ?? 0,
        edu_count: input.body.edus?.length ?? 0,
      }),
    );
    await emitEffectWarning("[federation-service] processing transaction", {
      origin: input.origin,
      txnId: input.txnId,
      pdus: input.body.pdus?.length ?? 0,
      edus: input.body.edus?.length ?? 0,
    });

    const cached = await this.repository.getCachedTransaction(input.origin, input.txnId);
    if (cached) {
      return cached as { pdus: Record<string, unknown> };
    }

    const pduResults: Record<string, unknown> = {};
    let acceptedPduCount = 0;
    let rejectedPduCount = 0;
    let processedEduCount = 0;

    for (const rawPdu of input.body.pdus || []) {
      const pdu = toRawFederationPdu(rawPdu);
      const {
        roomId,
        sender,
        eventType,
        content,
        eventId: incomingEventId,
      } = extractRawFederationPduFields(pdu);

      try {
        if (!roomId || !sender || !eventType || !content) {
          const malformedEventId = incomingEventId ?? "unknown";
          pduResults[malformedEventId] = { error: "Invalid PDU structure" };
          rejectedPduCount += 1;
          continue;
        }

        const room = await this.repository.getRoom(roomId);
        const roomVersion =
          room?.room_version ||
          (eventType === "m.room.create" && typeof content["room_version"] === "string"
            ? content["room_version"]
            : getDefaultRoomVersion());
        const eventIdFormat = getRoomVersion(roomVersion)?.eventIdFormat ?? "v4";
        const urlsafeEventId =
          eventIdFormat === "v1"
            ? (incomingEventId ?? null)
            : await calculateReferenceHashEventId(rawPdu, roomVersion);
        const standardEventId =
          eventIdFormat === "v1"
            ? (incomingEventId ?? null)
            : await calculateReferenceHashEventIdStandard(rawPdu, roomVersion);
        const normalizedEventId =
          eventIdFormat === "v1" ? (incomingEventId ?? null) : urlsafeEventId;
        const eventId = normalizedEventId || incomingEventId || "unknown";
        if (!normalizedEventId) {
          pduResults[eventId] = { error: "Invalid PDU structure" };
          rejectedPduCount += 1;
          continue;
        }
        if (eventIdFormat !== "v1") {
          await emitEffectWarning("[federation-service] normalized inbound PDU", {
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
          ...rawPdu,
          room_id: roomId,
          sender,
          type: eventType,
          content,
          event_id: normalizedEventId,
        } as PDU;

        const existingPdu = await this.repository.getProcessedPdu(normalizedEventId);
        if (existingPdu) {
          pduResults[eventId] = existingPdu.accepted
            ? {}
            : { error: existingPdu.rejectionReason || "Previously rejected" };
          continue;
        }

        const pduOrigin = extractServerNameFromMatrixId(sender);
        if (!pduOrigin) {
          pduResults[eventId] = { error: "Invalid sender format" };
          rejectedPduCount += 1;
          continue;
        }

        if (normalizedPdu.signatures) {
          let signatureValid = false;
          const cache = this.appContext.capabilities.kv.cache as KVNamespace;
          const signatories = Object.keys(normalizedPdu.signatures);
          for (const signatory of signatories) {
            const keyIds = Object.keys(normalizedPdu.signatures[signatory]);
            for (const keyId of keyIds) {
              try {
                const validByService = await verifyRemoteSignature(
                  normalizedPdu as unknown as Record<string, unknown>,
                  signatory,
                  keyId,
                  this.appContext.capabilities.sql.connection as D1Database,
                  cache,
                );
                const validByTransport = await this.signedTransport.verifyJson(
                  normalizedPdu as unknown as Record<string, unknown>,
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
            if (signatureValid) break;
          }

          if (!signatureValid && pduOrigin !== input.origin) {
            pduResults[eventId] = { error: "Invalid signature" };
            rejectedPduCount += 1;
            await this.repository.recordProcessedPdu(
              eventId,
              pduOrigin,
              roomId,
              false,
              "Invalid signature",
            );
            continue;
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
            const rawHash = await calculateContentHash(rawPdu);
            const normalizedHash = await calculateContentHash(
              normalizedPdu as unknown as Record<string, unknown>,
            );
            const withoutEventIdHash = await calculateContentHash({
              ...normalizedPdu,
              event_id: undefined,
            } as unknown as Record<string, unknown>);
            await emitEffectWarning("[federation-service] content hash mismatch", {
              origin: input.origin,
              roomId,
              roomVersion,
              eventId,
              eventType: normalizedPdu.type,
              hadIncomingEventId: typeof rawPdu.event_id === "string",
              expectedHash: normalizedPdu.hashes.sha256,
              rawHash,
              normalizedHash,
              withoutEventIdHash,
              rawKeys: Object.keys(rawPdu).sort(),
              unsignedKeys:
                rawPdu.unsigned &&
                typeof rawPdu.unsigned === "object" &&
                !Array.isArray(rawPdu.unsigned)
                  ? Object.keys(rawPdu.unsigned as Record<string, unknown>).sort()
                  : [],
            });
            pduResults[eventId] = { error: "Content hash mismatch" };
            rejectedPduCount += 1;
            await this.repository.recordProcessedPdu(
              eventId,
              pduOrigin,
              roomId,
              false,
              "Content hash mismatch",
            );
            continue;
          }
        }

        if (room) {
          const aclPolicy = createServerAclPolicy(await this.repository.getRoomState(roomId));
          const aclDecision = aclPolicy.allowPdu(input.origin, roomId, normalizedPdu);
          if (aclDecision.kind === "deny") {
            await emitEffectWarning("[federation-service] ACL rejected PDU", {
              origin: input.origin,
              roomId,
              eventId,
              eventType: normalizedPdu.type,
              reason: aclDecision.reason,
            });
            pduResults[eventId] = { error: aclDecision.reason };
            rejectedPduCount += 1;
            await this.repository.recordProcessedPdu(
              eventId,
              pduOrigin,
              roomId,
              false,
              aclDecision.reason,
            );
            continue;
          }

          try {
            let roomState = await this.repository.getRoomState(roomId);
            const inviteStrippedState = await this.repository.getInviteStrippedState(roomId);
            roomState = resolveMembershipAuthState(roomId, roomState, inviteStrippedState);
            const authResult = checkEventAuth(normalizedPdu, roomState, room.room_version);
            if (!authResult.allowed) {
              await emitEffectWarning("[federation-service] rejected PDU", {
                roomId,
                eventId,
                type: normalizedPdu.type,
                sender: normalizedPdu.sender,
                stateKey: normalizedPdu.state_key,
                reason: authResult.error || "Auth failed",
              });
              pduResults[eventId] = { error: authResult.error || "Event authorization failed" };
              rejectedPduCount += 1;
              await this.repository.recordProcessedPdu(
                eventId,
                pduOrigin,
                roomId,
                false,
                authResult.error || "Auth failed",
              );
              continue;
            }
          } catch {
            // Accept if auth evaluation itself fails.
          }
        }

        pduResults[eventId] = {};
        acceptedPduCount += 1;
        await this.repository.recordProcessedPdu(normalizedEventId, pduOrigin, roomId, true);

        await this.storeAcceptedPdu(normalizedPdu);
      } catch (error) {
        const eventId = incomingEventId || "unknown";
        pduResults[eventId] = {
          error: error instanceof Error ? error.message : "Unknown error",
        };
        rejectedPduCount += 1;
        if (incomingEventId && roomId) {
          const pduOrigin = extractServerNameFromMatrixId(sender ?? "") || input.origin;
          await this.repository.recordProcessedPdu(
            incomingEventId,
            pduOrigin,
            roomId,
            false,
            error instanceof Error ? error.message : "Unknown error",
          );
        }
      }
    }

    for (const edu of input.body.edus || []) {
      try {
        await this.processEdu(input.origin, edu);
        processedEduCount += 1;
      } catch (error) {
        await runFederationEffect(
          logger.warn("federation.transaction.edu_error", {
            edu_type: typeof edu["edu_type"] === "string" ? edu["edu_type"] : undefined,
            error_message: error instanceof Error ? error.message : String(error),
          }),
        );
        await emitEffectWarning("[federation-service] failed to process EDU", {
          origin: input.origin,
          eduType: typeof edu["edu_type"] === "string" ? edu["edu_type"] : undefined,
          error: error instanceof Error ? error.message : String(error),
        });
        // EDU processing failures should not abort the transaction
      }
    }

    const response = { pdus: pduResults };
    await this.repository.storeCachedTransaction(input.origin, input.txnId, response);
    await runFederationEffect(
      logger.info("federation.transaction.result", {
        accepted_pdu_count: acceptedPduCount,
        rejected_pdu_count: rejectedPduCount,
        processed_edu_count: processedEduCount,
      }),
    );
    return response;
  }

  private async storeAcceptedPdu(pdu: PDU): Promise<void> {
    const existingRoom = await this.repository.getRoom(pdu.room_id);
    const priorRoomState =
      pdu.type === "m.room.member" && pdu.state_key
        ? await this.repository.getRoomState(pdu.room_id)
        : [];
    const priorInviteStrippedState =
      pdu.type === "m.room.member" && pdu.state_key
        ? await this.repository.getInviteStrippedState(pdu.room_id)
        : [];
    if (!existingRoom) {
      const content = pdu.content as { room_version?: string; creator?: string };
      const roomVersion = pdu.type === "m.room.create" ? content.room_version || "10" : "10";
      await this.repository.createRoom(
        pdu.room_id,
        roomVersion,
        content.creator || pdu.sender || "",
        false,
      );
    }
    await this.repository.storeIncomingEvent(pdu);

    if (pdu.type === "m.room.member" && pdu.state_key) {
      const currentMemberEvent =
        resolveMembershipAuthState(pdu.room_id, priorRoomState, priorInviteStrippedState).find(
          (event) => event.type === "m.room.member" && event.state_key === pdu.state_key,
        ) ?? null;
      const result = this.membershipTransitions.evaluate({
        event: pdu,
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
        const memberContent = pdu.content as { displayname?: string; avatar_url?: string };
        await this.repository.updateMembership(
          pdu.room_id,
          pdu.state_key,
          result.membershipToPersist,
          pdu.event_id,
          memberContent.displayname,
          memberContent.avatar_url,
        );
      }
    }

    await this.repository.notifyUsersOfEvent(pdu.room_id, pdu.event_id, pdu.type);
    if (pdu.state_key === undefined) {
      return;
    }

    const prevEvents = pdu.prev_events || [];
    if (prevEvents.length > 1) {
      try {
        const currentState = await this.repository.getRoomState(pdu.room_id);
        const resolved = resolveState(existingRoom?.room_version || "10", [currentState, [pdu]]);
        for (const stateEvent of resolved) {
          if (stateEvent.state_key !== undefined) {
            await this.repository.upsertRoomState(
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

    await this.repository.upsertRoomState(pdu.room_id, pdu.type, pdu.state_key, pdu.event_id);
  }

  private async processEdu(origin: string, rawEdu: Record<string, unknown>): Promise<void> {
    const edu = toRawFederationEdu(rawEdu);
    const eduType = typeof edu.edu_type === "string" ? edu.edu_type : "";
    const content =
      edu.content && typeof edu.content === "object" && !Array.isArray(edu.content)
        ? edu.content
        : {};
    const roomScopedRoomIds = getRoomScopedEduRoomIds(eduType, content);

    for (const roomId of roomScopedRoomIds) {
      const room = await this.repository.getRoom(roomId);
      if (!room) {
        continue;
      }

      const aclPolicy = createServerAclPolicy(await this.repository.getRoomState(roomId));
      const aclDecision = aclPolicy.allowRoomScopedEdu(origin, {
        eduType,
        roomId,
        userId: typeof content.user_id === "string" ? content.user_id : undefined,
      });
      if (aclDecision.kind === "deny") {
        await emitEffectWarning("[federation-service] ACL rejected EDU", {
          origin,
          roomId,
          eduType,
          reason: aclDecision.reason,
        });
        return;
      }
    }

    switch (eduType) {
      case "m.presence": {
        if (isPresenceEduContent(content)) {
          await handleFederationPresenceEdu(
            this.repository,
            this.appContext.capabilities.clock.now(),
            content,
          );
        }
        break;
      }
      case "m.device_list_update": {
        await handleFederationDeviceListEdu(this.repository, content);
        break;
      }
      case "m.typing": {
        if (isTypingEduContent(content)) {
          await handleFederationTypingEdu(
            this.appContext.capabilities.sql.connection as D1Database,
            origin,
            this.appContext.capabilities.realtime,
            content,
          );
        }
        break;
      }
      case "m.direct_to_device": {
        if (isDirectToDeviceEduContent(content)) {
          await handleFederationDirectToDeviceEdu(
            this.appContext.capabilities.sql.connection as D1Database,
            origin,
            content,
          );
        }
        break;
      }
      default:
        break;
    }

    const eduId = await sha256(`${origin}:${eduType}:${this.appContext.capabilities.clock.now()}`);
    const processedEdu = content ? { ...content, edu_id: eduId } : { edu_id: eduId };
    await this.repository.storeProcessedEdu(origin, eduType, processedEdu);
  }
}
