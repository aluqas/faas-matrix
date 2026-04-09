import { describe, expect, it } from "vitest";
import { runFederationEffect } from "../../matrix/application/runtime/effect-runtime";
import type { AppContext } from "../../shared/runtime/app-context";
import type { SignedTransport } from "./contracts";
import type { FederationRepository } from "../../infra/repositories/interfaces";
import { processFederationTransaction } from "./transaction";

class FakeFederationRepository implements FederationRepository {
  cached: Record<string, unknown> | null = null;
  storedResponses: Array<{ origin: string; txnId: string; response: Record<string, unknown> }> = [];

  getCachedTransaction() {
    return this.cached;
  }
  storeCachedTransaction(origin: string, txnId: string, response: Record<string, unknown>) {
    this.storedResponses.push({ origin, txnId, response });
  }
  getProcessedPdu() {
    return null;
  }
  async recordProcessedPdu() {}
  async createRoom() {}
  getRoom(roomId: string) {
    if (roomId === "!room:test") {
      return { room_id: roomId, room_version: "10", is_public: true, created_at: 1 };
    }
    return null;
  }
  getEvent() {
    return null;
  }
  getLatestRoomEvents() {
    return [];
  }
  getRoomState(roomId: string) {
    if (roomId !== "!room:test") {
      return [];
    }
    return [
      {
        event_id: "$acl",
        room_id: roomId,
        sender: "@admin:test",
        type: "m.room.server_acl",
        state_key: "",
        content: { allow: ["*"], deny: ["blocked.example"] },
        origin_server_ts: 1,
        depth: 1,
        auth_events: [],
        prev_events: [],
      },
    ];
  }
  getInviteStrippedState() {
    return [];
  }
  async storeIncomingEvent() {}
  async notifyUsersOfEvent() {}
  async updateMembership() {}
  async upsertRoomState() {}
  async storeProcessedEdu() {}
  async upsertPresence() {}
  async upsertRemoteDeviceList() {}
}

function createAppContext(): AppContext {
  return {
    capabilities: {
      sql: { connection: {} as D1Database },
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
      clock: { now: () => 1234 },
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

describe("federation transaction contracts", () => {
  it("short-circuits cached transaction responses", async () => {
    const repository = new FakeFederationRepository();
    repository.cached = { pdus: { $cached: {} } };

    const result = await processFederationTransaction(
      {
        appContext: createAppContext(),
        repository,
        signedTransport: {} as SignedTransport,
        runEffect: runFederationEffect,
      },
      {
        origin: "remote.example",
        txnId: "txn-1",
        body: {},
      },
    );

    expect(result).toEqual({
      pdus: { $cached: {} },
      acceptedPduCount: 0,
      rejectedPduCount: 0,
      processedEduCount: 0,
      softFailedEventIds: [],
    });
  });

  it("aggregates malformed PDU rejection and ACL-rejected EDU without touching the whole suite", async () => {
    const repository = new FakeFederationRepository();

    const result = await processFederationTransaction(
      {
        appContext: createAppContext(),
        repository,
        signedTransport: {} as SignedTransport,
        runEffect: runFederationEffect,
      },
      {
        origin: "blocked.example",
        txnId: "txn-2",
        body: {
          pdus: [{ event_id: "$broken" }],
          edus: [
            {
              edu_type: "m.typing",
              content: {
                room_id: "!room:test",
                user_id: "@bob:blocked.example",
                typing: true,
              },
            },
          ],
        },
      },
    );

    expect(result.rejectedPduCount).toBe(1);
    expect(result.processedEduCount).toBe(0);
    expect(result.pdus).toEqual({
      $broken: { error: "Invalid PDU structure" },
    });
    expect(repository.storedResponses).toHaveLength(1);
    expect(repository.storedResponses[0]?.txnId).toBe("txn-2");
  });
});
