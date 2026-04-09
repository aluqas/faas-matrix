import { describe, expect, it } from "vitest";
import { runFederationEffect } from "../../matrix/application/runtime/effect-runtime";
import { ingestFederationEdu } from "./edu-ingest";
import type { FederationRepository } from "../../infra/repositories/interfaces";
import type { AppContext } from "../../shared/runtime/app-context";

class FakeFederationRepository implements Pick<
  FederationRepository,
  "getRoom" | "getRoomState" | "storeProcessedEdu" | "upsertPresence" | "upsertRemoteDeviceList"
> {
  storedEdus: Array<{ origin: string; eduType: string; content: Record<string, unknown> }> = [];
  presenceCalls = 0;
  deviceListCalls = 0;

  getRoom(roomId: string) {
    if (roomId === "!room:test") {
      return { room_id: roomId, room_version: "10", is_public: true, created_at: 1 };
    }
    return null;
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

  storeProcessedEdu(origin: string, eduType: string, content: Record<string, unknown>) {
    this.storedEdus.push({ origin, eduType, content });
  }

  upsertPresence() {
    this.presenceCalls += 1;
  }

  upsertRemoteDeviceList() {
    this.deviceListCalls += 1;
  }
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

describe("federation edu ingest", () => {
  it("rejects ACL-denied room-scoped EDUs through the injected effect runner", async () => {
    const repository = new FakeFederationRepository();
    const warnings: string[] = [];

    const result = await ingestFederationEdu(
      {
        appContext: createAppContext(),
        repository: repository as unknown as FederationRepository,
        runEffect(effect) {
          warnings.push("ran");
          return runFederationEffect(effect);
        },
      },
      {
        origin: "blocked.example",
        rawEdu: {
          edu_type: "m.typing",
          content: {
            room_id: "!room:test",
            user_id: "@alice:blocked.example",
            typing: true,
          },
        },
      },
    );

    expect(result).toEqual({
      kind: "rejected",
      eduType: "m.typing",
      roomIds: ["!room:test"],
      reason:
        "Server blocked.example is denied by m.room.server_acl for EDU m.typing in !room:test",
    });
    expect(warnings).toHaveLength(1);
    expect(repository.storedEdus).toHaveLength(0);
  });

  it("stores applied presence EDUs and does not require room ACL checks", async () => {
    const repository = new FakeFederationRepository();

    const result = await ingestFederationEdu(
      {
        appContext: createAppContext(),
        repository: repository as unknown as FederationRepository,
        runEffect: runFederationEffect,
      },
      {
        origin: "remote.example",
        rawEdu: {
          edu_type: "m.presence",
          content: {
            push: [
              {
                user_id: "@alice:remote.example",
                presence: "online",
              },
            ],
          },
        },
      },
    );

    expect(result.kind).toBe("applied");
    expect(repository.presenceCalls).toBe(1);
    expect(repository.storedEdus).toHaveLength(1);
  });
});
