import { describe, expect, it } from 'vitest';
import type { AppContext } from '../../foundation/app-context';
import { MatrixSyncService } from './sync-service';
import type { SyncRepository } from '../repositories/interfaces';

class FakeSyncRepository implements SyncRepository {
  waitCalls = 0;

  async loadFilter() { return null; }
  async getLatestStreamPosition() { return 5; }
  async getToDeviceMessages() { return { events: [], nextBatch: '0' }; }
  async getOneTimeKeyCounts() { return {}; }
  async getUnusedFallbackKeyTypes() { return []; }
  async getDeviceListChanges() { return { changed: [], left: [] }; }
  async getGlobalAccountData() { return []; }
  async getRoomAccountData() { return []; }
  async getUserRooms() { return []; }
  async getEventsSince() { return []; }
  async getRoomState() { return []; }
  async getReceiptsForRoom() { return { type: 'm.receipt', content: {} }; }
  async getTypingUsers() { return []; }
  async waitForUserEvents() {
    this.waitCalls += 1;
    return { hasEvents: false };
  }
}

describe('MatrixSyncService', () => {
  it('preserves composite sync tokens and waits when idle', async () => {
    const repo = new FakeSyncRepository();
    const service = new MatrixSyncService({} as AppContext, repo);

    const response = await service.syncUser({
      userId: '@alice:test',
      deviceId: null,
      since: 's2_td0',
      timeout: 2000,
    });

    expect(repo.waitCalls).toBe(1);
    expect(response.next_batch).toBe('s5_td0');
  });
});

