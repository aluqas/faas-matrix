import { describe, expect, it } from "vitest";
import type { AppContext } from "../../../../foundation/app-context";
import type { SyncRepository } from "../../../repositories/interfaces";
import { projectTopLevelSync } from "./top-level";

class FakeSyncRepository implements SyncRepository {
  loadFilter() {
    return null;
  }
  getLatestStreamPosition() {
    return 12;
  }
  getLatestDeviceKeyPosition() {
    return 20;
  }
  getToDeviceMessages() {
    return {
      events: [{ sender: "@alice:test", type: "m.room_key", content: { key: "k" } }],
      nextBatch: "9",
    };
  }
  getOneTimeKeyCounts() {
    return { signed_curve25519: 2 };
  }
  getUnusedFallbackKeyTypes() {
    return ["signed_curve25519"];
  }
  getDeviceListChanges(
    _userId: string,
    sinceEventPosition: number,
    sinceDeviceKeyPosition: number,
  ) {
    if (sinceEventPosition === 0 && sinceDeviceKeyPosition === 0) {
      return { changed: ["@bootstrap:test"], left: [] };
    }
    return { changed: ["@delta:test"], left: ["@left:test"] };
  }
  getGlobalAccountData() {
    return [{ type: "m.direct", content: { "@alice:test": ["!room:test"] } }];
  }
  getRoomAccountData() {
    return [];
  }
  getUserRooms() {
    return [];
  }
  getMembership() {
    return null;
  }
  getEventsSince() {
    return [];
  }
  getEvent() {
    return null;
  }
  getRoomState() {
    return [];
  }
  getInviteStrippedState() {
    return [];
  }
  getReceiptsForRoom() {
    return { type: "m.receipt", content: {} };
  }
  getUnreadNotificationSummary() {
    return {
      room: { notification_count: 0, highlight_count: 0 },
      main: { notification_count: 0, highlight_count: 0 },
      threads: {},
    };
  }
  getTypingUsers() {
    return [];
  }
  waitForUserEvents() {
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
    expect(initial.accountData).toEqual(
      expect.arrayContaining([
        { type: "m.direct", content: { "@alice:test": ["!room:test"] } },
        expect.objectContaining({ type: "m.push_rules" }),
      ]),
    );
    expect(incremental.currentToDevicePos).toBe(9);
  });
});
