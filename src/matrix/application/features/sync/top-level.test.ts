import { describe, expect, it } from "vitest";
import type { AppContext } from "../../../../foundation/app-context";
import type { SyncRepository } from "../../../repositories/interfaces";
import { projectTopLevelSync } from "./top-level";

class FakeSyncRepository implements SyncRepository {
  async loadFilter() {
    return null;
  }
  async getLatestStreamPosition() {
    return 12;
  }
  async getLatestDeviceKeyPosition() {
    return 20;
  }
  async getToDeviceMessages() {
    return {
      events: [{ sender: "@alice:test", type: "m.room_key", content: { key: "k" } }],
      nextBatch: "9",
    };
  }
  async getOneTimeKeyCounts() {
    return { signed_curve25519: 2 };
  }
  async getUnusedFallbackKeyTypes() {
    return ["signed_curve25519"];
  }
  async getDeviceListChanges(
    _userId: string,
    sinceEventPosition: number,
    sinceDeviceKeyPosition: number,
  ) {
    if (sinceEventPosition === 0 && sinceDeviceKeyPosition === 0) {
      return { changed: ["@bootstrap:test"], left: [] };
    }
    return { changed: ["@delta:test"], left: ["@left:test"] };
  }
  async getGlobalAccountData() {
    return [{ type: "m.direct", content: { "@alice:test": ["!room:test"] } }];
  }
  async getRoomAccountData() {
    return [];
  }
  async getUserRooms() {
    return [];
  }
  async getMembership() {
    return null;
  }
  async getEventsSince() {
    return [];
  }
  async getEvent() {
    return null;
  }
  async getRoomState() {
    return [];
  }
  async getInviteStrippedState() {
    return [];
  }
  async getReceiptsForRoom() {
    return { type: "m.receipt", content: {} };
  }
  async getUnreadNotificationSummary() {
    return {
      room: { notification_count: 0, highlight_count: 0 },
      main: { notification_count: 0, highlight_count: 0 },
      threads: {},
    };
  }
  async getTypingUsers() {
    return [];
  }
  async waitForUserEvents() {
    return { hasEvents: false };
  }
}

function createAppContext(): AppContext {
  const db = {
    prepare() {
      return {
        bind() {
          return {
            async all() {
              return { results: [] };
            },
            async first() {
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
        async createRoomJoin() {
          return {};
        },
        async createPushNotification() {
          return {};
        },
      },
      rateLimit: {},
      realtime: {
        async notifyRoomEvent() {},
        async waitForUserEvents() {
          return { hasEvents: false };
        },
      },
      metrics: {},
      clock: { now: () => Date.now() },
      id: {
        async generateRoomId() {
          return "!room:test";
        },
        async generateEventId() {
          return "$event:test";
        },
        async generateOpaqueId() {
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
  } as AppContext;
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
    expect(initial.accountData).toEqual([
      { type: "m.direct", content: { "@alice:test": ["!room:test"] } },
    ]);
    expect(incremental.currentToDevicePos).toBe(9);
  });
});
