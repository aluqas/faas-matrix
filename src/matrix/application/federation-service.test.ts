import { describe, expect, it } from 'vitest';
import type { AppContext } from '../../foundation/app-context';
import { MatrixFederationService } from './federation-service';
import type { FederationProcessedPdu, FederationRepository } from '../repositories/interfaces';

class FakeFederationRepository implements FederationRepository {
  cachedResponse: Record<string, unknown> | null = null;

  async getCachedTransaction() { return this.cachedResponse; }
  async storeCachedTransaction() {}
  async getProcessedPdu(): Promise<FederationProcessedPdu | null> { return null; }
  async recordProcessedPdu() {}
  async createRoom() {}
  async getRoom() { return null; }
  async getRoomState() { return []; }
  async getInviteStrippedState() { return []; }
  async storeIncomingEvent() {}
  async notifyUsersOfEvent() {}
  async updateMembership() {}
  async upsertRoomState() {}
  async storeProcessedEdu() {}
  async upsertPresence() {}
  async upsertRemoteDeviceList() {}
}

function createFederationService(repo: FederationRepository) {
  return new MatrixFederationService(
    {
      capabilities: {
        sql: { connection: {} },
        kv: { cache: {} },
        blob: {},
        jobs: { defer() {} },
        workflow: {
          async createRoomJoin() { return {}; },
          async createPushNotification() { return {}; },
        },
        rateLimit: {},
        realtime: {
          async notifyRoomEvent() {},
          async waitForUserEvents() { return { hasEvents: false }; },
        },
        metrics: {},
        clock: { now: () => 1_700_000_000_000 },
        id: {
          async generateRoomId() { return '!room:test'; },
          async generateEventId() { return '$event'; },
          async generateOpaqueId() { return 'opaque'; },
          formatRoomAlias(localpart: string, serverName: string) { return `#${localpart}:${serverName}`; },
        },
        config: { serverName: 'test', serverVersion: '0.1.0' },
      },
      profile: {
        name: 'full',
        features: {
          adminApi: true,
          e2ee: true,
          federation: true,
          media: true,
          mediaPreviews: true,
          presence: true,
          pushNotifications: true,
          slidingSync: true,
        },
      },
      services: {},
      defer(_task: Promise<unknown>) {},
    } as AppContext,
    repo,
    { async verifyJson() { return false; } },
    { async discover() { return { host: 'example.com', port: 8448, tlsHostname: 'example.com' }; } },
    { async enqueue() {} },
    { async get() { return null; }, async put() {} }
  );
}

describe('MatrixFederationService', () => {
  it('returns cached transaction responses', async () => {
    const repo = new FakeFederationRepository();
    repo.cachedResponse = { pdus: { cached: {} } };
    const service = createFederationService(repo);

    const response = await service.processTransaction({
      origin: 'remote.example',
      txnId: 'txn-1',
      body: {},
    });

    expect(response).toEqual({ pdus: { cached: {} } });
  });

  it('rejects malformed PDUs', async () => {
    const repo = new FakeFederationRepository();
    const service = createFederationService(repo);

    const response = await service.processTransaction({
      origin: 'remote.example',
      txnId: 'txn-2',
      body: {
        pdus: [{ event_id: '$broken' }],
      },
    });

    expect(response.pdus).toEqual({
      $broken: { error: 'Invalid PDU structure' },
    });
  });
});
