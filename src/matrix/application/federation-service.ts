import type { AppContext } from '../../foundation/app-context';
import type { DeliveryQueue, DiscoveryService, RemoteKeyCache, SignedTransport } from '../../fedcore/contracts';
import { checkEventAuth } from '../../services/event-auth';
import { resolveState } from '../../services/state-resolution';
import type { PDU, Room } from '../../types';
import { sha256, verifyContentHash } from '../../utils/crypto';
import { verifyRemoteSignature } from '../../services/federation-keys';
import type { FederationRepository } from '../repositories/interfaces';

export interface FederationTransactionInput {
  origin: string;
  txnId: string;
  body: {
    pdus?: Array<Record<string, any>>;
    edus?: Array<Record<string, any>>;
  };
}

interface CachedKeyRecord {
  keyId: string;
  key: string;
}

export class MatrixFederationService {
  constructor(
    private readonly appContext: AppContext,
    private readonly repository: FederationRepository,
    private readonly signedTransport: SignedTransport,
    private readonly discoveryService: DiscoveryService,
    private readonly deliveryQueue: DeliveryQueue,
    private readonly remoteKeyCache: RemoteKeyCache<CachedKeyRecord>
  ) {
    void this.appContext;
    void this.discoveryService;
    void this.deliveryQueue;
    void this.remoteKeyCache;
  }

  async processTransaction(input: FederationTransactionInput): Promise<{ pdus: Record<string, unknown> }> {
    const cached = await this.repository.getCachedTransaction(input.origin, input.txnId);
    if (cached) {
      return cached as { pdus: Record<string, unknown> };
    }

    const pduResults: Record<string, unknown> = {};

    for (const pdu of input.body.pdus || []) {
      const eventId = pdu.event_id || 'unknown';
      const roomId = pdu.room_id || '';

      try {
        const existingPdu = pdu.event_id
          ? await this.repository.getProcessedPdu(pdu.event_id)
          : null;

        if (existingPdu) {
          pduResults[eventId] = existingPdu.accepted
            ? {}
            : { error: existingPdu.rejectionReason || 'Previously rejected' };
          continue;
        }

        if (!pdu.event_id || !pdu.room_id || !pdu.sender || !pdu.type || !pdu.content) {
          pduResults[eventId] = { error: 'Invalid PDU structure' };
          continue;
        }

        const pduOrigin = String(pdu.sender).split(':')[1];
        if (!pduOrigin) {
          pduResults[eventId] = { error: 'Invalid sender format' };
          continue;
        }

        if (pdu.signatures) {
          let signatureValid = false;
          const cache = this.appContext.capabilities.kv.cache as KVNamespace;
          const signatories = Object.keys(pdu.signatures);
          for (const signatory of signatories) {
            const keyIds = Object.keys(pdu.signatures[signatory]);
            for (const keyId of keyIds) {
              try {
                const validByService = await verifyRemoteSignature(
                  pdu,
                  signatory,
                  keyId,
                  this.appContext.capabilities.sql.connection as D1Database,
                  cache
                );
                const validByTransport = await this.signedTransport.verifyJson(
                  pdu,
                  signatory,
                  keyId
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
            pduResults[eventId] = { error: 'Invalid signature' };
            await this.repository.recordProcessedPdu(eventId, pduOrigin, roomId, false, 'Invalid signature');
            continue;
          }
        }

        if (pdu.hashes?.sha256) {
          const hashValid = await verifyContentHash(pdu as Record<string, unknown>, pdu.hashes.sha256);
          if (!hashValid) {
            pduResults[eventId] = { error: 'Content hash mismatch' };
            await this.repository.recordProcessedPdu(eventId, pduOrigin, roomId, false, 'Content hash mismatch');
            continue;
          }
        }

        const room = await this.repository.getRoom(roomId);
        if (room) {
          try {
            const roomState = await this.repository.getRoomState(roomId);
            const authResult = checkEventAuth(pdu as PDU, roomState, room.room_version);
            if (!authResult.allowed) {
              pduResults[eventId] = { error: authResult.error || 'Event authorization failed' };
              await this.repository.recordProcessedPdu(
                eventId,
                pduOrigin,
                roomId,
                false,
                authResult.error || 'Auth failed'
              );
              continue;
            }
          } catch {
            // Accept if auth evaluation itself fails.
          }
        }

        pduResults[eventId] = {};
        await this.repository.recordProcessedPdu(eventId, pduOrigin, roomId, true);

        if (room) {
          await this.storeAcceptedPdu(pdu as PDU, room);
        }
      } catch (error) {
        pduResults[eventId] = {
          error: error instanceof Error ? error.message : 'Unknown error',
        };
        if (pdu.event_id && pdu.room_id) {
          const pduOrigin = String(pdu.sender).split(':')[1] || input.origin;
          await this.repository.recordProcessedPdu(
            pdu.event_id,
            pduOrigin,
            pdu.room_id,
            false,
            error instanceof Error ? error.message : 'Unknown error'
          );
        }
      }
    }

    for (const edu of input.body.edus || []) {
      await this.processEdu(input.origin, edu);
    }

    const response = { pdus: pduResults };
    await this.repository.storeCachedTransaction(input.origin, input.txnId, response);
    return response;
  }

  private async storeAcceptedPdu(pdu: PDU, room: Room): Promise<void> {
    await this.repository.storeIncomingEvent(pdu);
    if (pdu.state_key === undefined) {
      return;
    }

    const prevEvents = pdu.prev_events || [];
    if (prevEvents.length > 1) {
      try {
        const currentState = await this.repository.getRoomState(pdu.room_id);
        const resolved = resolveState(room.room_version, [currentState, [pdu]]);
        for (const stateEvent of resolved) {
          if (stateEvent.state_key !== undefined) {
            await this.repository.upsertRoomState(
              pdu.room_id,
              stateEvent.type,
              stateEvent.state_key,
              stateEvent.event_id
            );
          }
        }
        return;
      } catch {
        // Fall through to direct replacement.
      }
    }

    await this.repository.upsertRoomState(
      pdu.room_id,
      pdu.type,
      pdu.state_key,
      pdu.event_id
    );
  }

  private async processEdu(origin: string, edu: Record<string, any>): Promise<void> {
    const eduType = edu.edu_type;
    const content = edu.content as Record<string, any>;

    switch (eduType) {
      case 'm.presence': {
        const presencePush = content?.push as Array<{
          user_id: string;
          presence: string;
          status_msg?: string;
          last_active_ago?: number;
          currently_active?: boolean;
        }> | undefined;

        if (presencePush) {
          for (const update of presencePush) {
            if (update.user_id && update.presence) {
              const now = this.appContext.capabilities.clock.now();
              const lastActive = update.last_active_ago ? now - update.last_active_ago : now;
              await this.repository.upsertPresence(
                update.user_id,
                update.presence,
                update.status_msg || null,
                lastActive,
                Boolean(update.currently_active)
              );
            }
          }
        }
        break;
      }
      case 'm.device_list_update': {
        const deviceUserId = content?.user_id as string | undefined;
        const deviceId = content?.device_id as string | undefined;
        if (deviceUserId && deviceId) {
          await this.repository.upsertRemoteDeviceList(
            deviceUserId,
            deviceId,
            Number(content?.stream_id || 0),
            (content?.keys as Record<string, unknown> | undefined) || null,
            content?.device_display_name as string | undefined,
            Boolean(content?.deleted)
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
