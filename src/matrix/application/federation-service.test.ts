import { describe, expect, it } from "vitest";
import type { AppContext } from "../../foundation/app-context";
import { calculateContentHash, calculateReferenceHashEventId } from "../../utils/crypto";
import { MatrixFederationService } from "./federation-service";
import type { FederationProcessedPdu, FederationRepository } from "../repositories/interfaces";

class FakeFederationRepository implements FederationRepository {
  cachedResponse: Record<string, unknown> | null = null;
  roomState: any[] = [];
  events = new Map<string, any>();
  processedPdus = new Map<string, FederationProcessedPdu>();
  room: { room_id: string; room_version: string; is_public: boolean; created_at: number } | null =
    null;
  recordedPdus: Array<{
    eventId: string;
    origin: string;
    roomId: string;
    accepted: boolean;
    rejectionReason?: string;
  }> = [];

  async getCachedTransaction() {
    return this.cachedResponse;
  }
  async storeCachedTransaction() {}
  async getProcessedPdu(eventId: string): Promise<FederationProcessedPdu | null> {
    return this.processedPdus.get(eventId) ?? null;
  }
  async recordProcessedPdu(
    eventId: string,
    origin: string,
    roomId: string,
    accepted: boolean,
    rejectionReason?: string,
  ) {
    this.processedPdus.set(eventId, { accepted, rejectionReason: rejectionReason ?? null });
    this.recordedPdus.push({ eventId, origin, roomId, accepted, rejectionReason });
  }
  async createRoom() {}
  async getRoom() {
    return this.room;
  }
  async getEvent(eventId: string) {
    return this.events.get(eventId) ?? null;
  }
  async getLatestRoomEvents(_roomId: string) {
    return [];
  }
  async getRoomState() {
    return this.roomState;
  }
  async getInviteStrippedState() {
    return [];
  }
  async storeIncomingEvent(event: any) {
    this.events.set(event.event_id, event);
  }
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
        kv: {
          cache: {
            async get() {
              return null;
            },
            async put() {},
            async delete() {},
          },
        },
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
        clock: { now: () => 1_700_000_000_000 },
        id: {
          async generateRoomId() {
            return "!room:test";
          },
          async generateEventId() {
            return "$event";
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
        name: "full",
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
    {
      async verifyJson() {
        return false;
      },
    },
    {
      async discover() {
        return { host: "example.com", port: 8448, tlsHostname: "example.com" };
      },
    },
    { async enqueue() {} },
    {
      async get() {
        return null;
      },
      async put() {},
    },
  );
}

describe("MatrixFederationService", () => {
  it("returns cached transaction responses", async () => {
    const repo = new FakeFederationRepository();
    repo.cachedResponse = { pdus: { cached: {} } };
    const service = createFederationService(repo);

    const response = await service.processTransaction({
      origin: "remote.example",
      txnId: "txn-1",
      body: {},
    });

    expect(response).toEqual({ pdus: { cached: {} } });
  });

  it("rejects malformed PDUs", async () => {
    const repo = new FakeFederationRepository();
    const service = createFederationService(repo);

    const response = await service.processTransaction({
      origin: "remote.example",
      txnId: "txn-2",
      body: {
        pdus: [{ event_id: "$broken" }],
      },
    });

    expect(response.pdus).toEqual({
      $broken: { error: "Invalid PDU structure" },
    });
  });

  it("rejects PDUs from ACL-denied servers", async () => {
    const repo = new FakeFederationRepository();
    repo.room = {
      room_id: "!room:test",
      room_version: "1",
      is_public: true,
      created_at: 1,
    };
    repo.roomState = [
      {
        event_id: "$acl",
        room_id: "!room:test",
        sender: "@alice:test",
        type: "m.room.server_acl",
        state_key: "",
        content: {
          allow: ["*"],
          deny: ["blocked.example"],
        },
        origin_server_ts: 1,
        depth: 1,
        auth_events: [],
        prev_events: [],
      },
    ];
    const service = createFederationService(repo);

    const response = await service.processTransaction({
      origin: "blocked.example",
      txnId: "txn-3",
      body: {
        pdus: [
          {
            event_id: "$blocked",
            room_id: "!room:test",
            sender: "@bob:blocked.example",
            type: "m.room.message",
            content: { body: "blocked" },
            origin_server_ts: 2,
            depth: 2,
            auth_events: [],
            prev_events: [],
          },
        ],
      },
    });

    expect(response.pdus).toEqual({
      $blocked: {
        error: "Server blocked.example is denied by m.room.server_acl for PDU in !room:test",
      },
    });
    expect(repo.recordedPdus).toContainEqual({
      eventId: "$blocked",
      origin: "blocked.example",
      roomId: "!room:test",
      accepted: false,
      rejectionReason:
        "Server blocked.example is denied by m.room.server_acl for PDU in !room:test",
    });
  });

  it("derives event IDs for room v10 PDUs without event_id", async () => {
    const repo = new FakeFederationRepository();
    const service = createFederationService(repo);
    const createEvent = {
      room_id: "!room:test",
      sender: "@alice:remote.example",
      type: "m.room.create",
      state_key: "",
      content: { creator: "@alice:remote.example", room_version: "10" },
      origin_server_ts: 1,
      depth: 1,
      auth_events: [],
      prev_events: [],
    };
    const createEventWithHash = {
      ...createEvent,
      hashes: {
        sha256: await calculateContentHash(createEvent),
      },
    };
    const expectedEventId = await calculateReferenceHashEventId(createEventWithHash, "10");

    const response = await service.processTransaction({
      origin: "remote.example",
      txnId: "txn-4",
      body: {
        pdus: [createEventWithHash],
      },
    });

    expect(response.pdus).toEqual({
      [expectedEventId]: {},
    });
    expect(repo.recordedPdus).toContainEqual({
      eventId: expectedEventId,
      origin: "remote.example",
      roomId: "!room:test",
      accepted: true,
      rejectionReason: undefined,
    });
  });

  it("rejects PDUs whose auth events were previously rejected", async () => {
    const repo = new FakeFederationRepository();
    repo.room = {
      room_id: "!room:test",
      room_version: "10",
      is_public: true,
      created_at: 1,
    };
    repo.events.set("$create", {
      event_id: "$create",
      room_id: "!room:test",
      sender: "@alice:test",
      type: "m.room.create",
      state_key: "",
      content: { creator: "@alice:test", room_version: "10" },
      origin_server_ts: 1,
      depth: 1,
      auth_events: [],
      prev_events: [],
    });
    repo.events.set("$pl", {
      event_id: "$pl",
      room_id: "!room:test",
      sender: "@alice:test",
      type: "m.room.power_levels",
      state_key: "",
      content: { users: { "@charlie:remote.example": 100 }, users_default: 0, events_default: 0 },
      origin_server_ts: 2,
      depth: 2,
      auth_events: ["$create"],
      prev_events: ["$create"],
    });
    repo.events.set("$member", {
      event_id: "$member",
      room_id: "!room:test",
      sender: "@charlie:remote.example",
      type: "m.room.member",
      state_key: "@charlie:remote.example",
      content: { membership: "join" },
      origin_server_ts: 3,
      depth: 3,
      auth_events: ["$create", "$pl"],
      prev_events: ["$pl"],
    });
    repo.roomState = [repo.events.get("$create"), repo.events.get("$pl"), repo.events.get("$member")];
    repo.processedPdus.set("$rejected-auth", {
      accepted: false,
      rejectionReason: "Insufficient power level",
    });

    const service = createFederationService(repo);
    const messageEvent = {
      room_id: "!room:test",
      sender: "@charlie:remote.example",
      type: "m.room.message",
      content: { body: "hi", msgtype: "m.text" },
      origin_server_ts: 4,
      depth: 4,
      auth_events: ["$create", "$pl", "$member", "$rejected-auth"],
      prev_events: ["$member"],
    };
    const messageEventWithHash = {
      ...messageEvent,
      hashes: {
        sha256: await calculateContentHash(messageEvent),
      },
    };
    const eventId = await calculateReferenceHashEventId(messageEventWithHash, "10");

    const response = await service.processTransaction({
      origin: "remote.example",
      txnId: "txn-rejected-auth",
      body: {
        pdus: [messageEventWithHash],
      },
    });

    expect(response.pdus).toEqual({
      [eventId]: { error: "Auth event $rejected-auth was rejected" },
    });
    expect(repo.recordedPdus).toContainEqual({
      eventId,
      origin: "remote.example",
      roomId: "!room:test",
      accepted: false,
      rejectionReason: "Auth event $rejected-auth was rejected",
    });
  });
});
