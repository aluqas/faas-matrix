import { describe, expect, it } from "vitest";
import type { AppContext } from "../../foundation/app-context";
import { calculateContentHash, calculateReferenceHashEventId } from "../../utils/crypto";
import { MatrixFederationService } from "./federation-service";
import type { FederationProcessedPdu, FederationRepository } from "../repositories/interfaces";

class FakeFederationRepository implements FederationRepository {
  cachedResponse: Record<string, unknown> | null = null;
  roomState: any[] = [];
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
  async getProcessedPdu(): Promise<FederationProcessedPdu | null> {
    return null;
  }
  async recordProcessedPdu(
    eventId: string,
    origin: string,
    roomId: string,
    accepted: boolean,
    rejectionReason?: string,
  ) {
    this.recordedPdus.push({ eventId, origin, roomId, accepted, rejectionReason });
  }
  async createRoom() {}
  async getRoom() {
    return this.room;
  }
  async getRoomState() {
    return this.roomState;
  }
  async getInviteStrippedState() {
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

function createFederationService(repo: FederationRepository) {
  return new MatrixFederationService(
    {
      capabilities: {
        sql: { connection: {} },
        kv: { cache: {} },
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
});
