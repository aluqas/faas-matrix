import { describe, expect, it } from "vitest";
import type { AppContext } from "../../shared/runtime/app-context";
import type { SyncRepository } from "../../infra/repositories/interfaces";
import type {
  AccountDataEvent,
  PDU,
  StrippedStateEvent,
  ToDeviceEvent,
  UserId,
} from "../../shared/types";
import type {
  ReceiptEvent,
  UnreadNotificationSummary,
  FilterDefinition,
  MembershipRecord,
} from "../../infra/repositories/interfaces";
import { projectTopLevelSync } from "./top-level";

class FakeSyncRepository implements SyncRepository {
  async loadFilter(): Promise<FilterDefinition | null> {
    return null;
  }
  async getLatestStreamPosition(): Promise<number> {
    return 12;
  }
  async getLatestDeviceKeyPosition(): Promise<number> {
    return 20;
  }
  async getToDeviceMessages(): Promise<{ events: ToDeviceEvent[]; nextBatch: string }> {
    return {
      events: [{ sender: "@alice:test", type: "m.room_key", content: { key: "k" } }],
      nextBatch: "9",
    };
  }
  async getOneTimeKeyCounts(): Promise<Record<string, number>> {
    return { signed_curve25519: 2 };
  }
  async getUnusedFallbackKeyTypes(): Promise<string[]> {
    return ["signed_curve25519"];
  }
  getDeviceListChanges(
    _userId: string,
    sinceEventPosition: number,
    sinceDeviceKeyPosition: number,
  ): Promise<{ changed: UserId[]; left: UserId[] }> {
    if (sinceEventPosition === 0 && sinceDeviceKeyPosition === 0) {
      return Promise.resolve({ changed: ["@bootstrap:test"], left: [] });
    }
    return Promise.resolve({ changed: ["@delta:test"], left: ["@left:test"] });
  }
  async getGlobalAccountData(): Promise<AccountDataEvent[]> {
    return [{ type: "m.direct", content: { "@alice:test": ["!room:test"] } }];
  }
  async getRoomAccountData(): Promise<AccountDataEvent[]> {
    return [];
  }
  async getUserRooms(): Promise<string[]> {
    return [];
  }
  async getMembership(): Promise<MembershipRecord | null> {
    return null;
  }
  async getEventsSince(): Promise<PDU[]> {
    return [];
  }
  async getEvent(): Promise<PDU | null> {
    return null;
  }
  async getRoomState(): Promise<PDU[]> {
    return [];
  }
  async getInviteStrippedState(): Promise<StrippedStateEvent[]> {
    return [];
  }
  async getReceiptsForRoom(): Promise<ReceiptEvent> {
    return { type: "m.receipt", content: {} };
  }
  async getUnreadNotificationSummary(): Promise<UnreadNotificationSummary> {
    return {
      room: { notification_count: 0, highlight_count: 0 },
      main: { notification_count: 0, highlight_count: 0 },
      threads: {},
    };
  }
  async getTypingUsers(): Promise<string[]> {
    return [];
  }
  async waitForUserEvents(): Promise<{ hasEvents: boolean }> {
    return { hasEvents: false };
  }
}

function createAppContext(): AppContext {
  const db = {
    prepare() {
      return {
        bind() {
          return {
            all() {
              return { results: [] };
            },
            first() {
              return null;
            },
          };
        },
      };
    },
  } as unknown as D1Database;

  return {
    capabilities: {
      sql: { connection: db },
      kv: { cache: undefined },
      blob: {},
      jobs: { defer() {} },
      workflow: {
        createRoomJoin() {
          return {};
        },
        createPushNotification() {
          return {};
        },
      },
      rateLimit: {},
      realtime: {
        async notifyRoomEvent() {},
        waitForUserEvents() {
          return { hasEvents: false };
        },
      },
      metrics: {},
      clock: { now: () => Date.now() },
      id: {
        generateRoomId() {
          return "!room:test";
        },
        generateEventId() {
          return "$event:test";
        },
        generateOpaqueId() {
          return "opaque";
        },
        formatRoomAlias(localpart: string, serverName: string) {
          return `#${localpart}:${serverName}`;
        },
      },
      config: { serverName: "test", serverVersion: "0.1.0" },
    },
    profile: {
      name: "complement",
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
    defer() {},
  } as unknown as AppContext;
}

describe("sync top-level contracts", () => {
  it("keeps bootstrap and incremental device-list semantics separate from to-device/account-data", async () => {
    const repository = new FakeSyncRepository();
    const ports = { repository, appContext: createAppContext() };

    const initial = await projectTopLevelSync(ports, {
      userId: "@alice:test",
      deviceId: "DEVICE",
      roomIds: ["!room:test"],
      sincePosition: 0,
      sinceToDevice: 0,
      sinceDeviceKeys: 0,
    });

    const incremental = await projectTopLevelSync(ports, {
      userId: "@alice:test",
      deviceId: "DEVICE",
      roomIds: ["!room:test"],
      sincePosition: 5,
      sinceToDevice: 7,
      sinceDeviceKeys: 9,
      sinceToken: "s5_td7_dk9",
    });

    expect(initial.deviceLists).toEqual({ changed: ["@alice:test"], left: [] });
    expect(incremental.deviceLists).toEqual({
      changed: ["@delta:test"],
      left: ["@left:test"],
    });
    expect(initial.toDeviceEvents).toHaveLength(1);
    expect(initial.accountData).toEqual(
      expect.arrayContaining([
        { type: "m.direct", content: { "@alice:test": ["!room:test"] } },
        expect.objectContaining({ type: "m.push_rules" }),
      ]),
    );
    expect(incremental.currentToDevicePos).toBe(9);
  });
});
