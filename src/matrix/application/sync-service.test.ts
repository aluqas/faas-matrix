import { describe, expect, it } from "vitest";
import type { AppContext } from "../../foundation/app-context";
import { MatrixSyncService } from "./sync-service";
import type { SyncRepository } from "../repositories/interfaces";
import type { PDU } from "../../types";
import { FORGOTTEN_ROOM_ACCOUNT_DATA_TYPE } from "./room-account-data";
import { runClientEffect } from "./effect-runtime";

class FakeSyncRepository implements SyncRepository {
  waitCalls = 0;
  loadedFilter: unknown = null;
  memberships = new Map<
    string,
    { membership: "invite" | "join" | "leave" | "ban"; eventId: string }
  >();
  roomStates = new Map<string, PDU[]>();
  inviteStates = new Map<
    string,
    Array<{ type: string; state_key: string; content: any; sender: string }>
  >();
  roomAccountData = new Map<string, Array<{ type: string; content: Record<string, unknown> }>>();
  inviteRooms: string[] = [];
  joinedRooms: string[] = [];
  eventsSince = new Map<string, PDU[]>();
  eventsById = new Map<string, PDU>();

  async loadFilter(_userId?: string, filterParam?: string) {
    if (filterParam?.startsWith("{")) {
      return JSON.parse(filterParam) as Awaited<ReturnType<SyncRepository["loadFilter"]>>;
    }

    return this.loadedFilter as Awaited<ReturnType<SyncRepository["loadFilter"]>>;
  }
  async getLatestStreamPosition() {
    return 5;
  }
  async getLatestDeviceKeyPosition() {
    return 7;
  }
  async getToDeviceMessages() {
    return { events: [], nextBatch: "0" };
  }
  async getOneTimeKeyCounts() {
    return {};
  }
  async getUnusedFallbackKeyTypes() {
    return [];
  }
  async getDeviceListChanges() {
    return { changed: [], left: [] };
  }
  async getGlobalAccountData() {
    return [];
  }
  async getRoomAccountData() {
    return this.roomAccountData.get(arguments[1] as string) ?? [];
  }
  async getUserRooms(_userId?: string, membership?: "join" | "invite" | "leave" | "ban" | "knock") {
    if (membership === "join") return this.joinedRooms;
    if (membership === "invite") return this.inviteRooms;
    if (membership === "leave") {
      return Array.from(this.memberships.entries())
        .filter(([, value]) => value.membership === "leave")
        .map(([key]) => key.split(":@")[0]);
    }
    if (membership === "ban") {
      return Array.from(this.memberships.entries())
        .filter(([, value]) => value.membership === "ban")
        .map(([key]) => key.split(":@")[0]);
    }
    return [];
  }
  async getMembership(roomId: string, userId: string) {
    return this.memberships.get(`${roomId}:${userId}`) ?? null;
  }
  async getEventsSince(roomId: string) {
    return this.eventsSince.get(roomId) ?? [];
  }
  async getEvent(eventId: string) {
    return this.eventsById.get(eventId) ?? null;
  }
  async getRoomState(roomId: string) {
    return this.roomStates.get(roomId) ?? [];
  }
  async getInviteStrippedState(roomId: string) {
    return this.inviteStates.get(roomId) ?? [];
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
    this.waitCalls += 1;
    return { hasEvents: false };
  }
}

function createTestAppContext(): AppContext {
  const db = {
    prepare() {
      return {
        bind() {
          return {
            async first() {
              return null;
            },
            async all() {
              return { results: [] };
            },
          };
        },
      };
    },
  } as unknown as D1Database;

  return {
    capabilities: {
      sql: { connection: db },
      kv: {},
      blob: {},
      jobs: { defer() {} },
      workflow: {
        async createRoomJoin() {
          return { status: "complete", output: { success: true } };
        },
        async createPushNotification() {},
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
      config: {
        serverName: "test",
        serverVersion: "test",
      },
    },
    profile: {} as AppContext["profile"],
    services: {},
    defer() {},
  };
}

function createCacheBackedAppContext(entries?: Record<string, unknown>): AppContext {
  const context = createTestAppContext();
  const store = new Map(
    Object.entries(entries ?? {}).map(([key, value]) => [key, JSON.stringify(value)]),
  );

  context.capabilities.kv = {
    cache: {
      async get(key: string, type?: "json") {
        const value = store.get(key);
        if (!value) {
          return null;
        }

        if (type === "json") {
          return JSON.parse(value) as unknown;
        }

        return value;
      },
      async delete(key: string) {
        store.delete(key);
      },
    } as KVNamespace,
  };

  return context;
}

function createPersistedPartialStateAppContext(entries?: Record<string, unknown>): AppContext {
  const context = createCacheBackedAppContext();
  const persisted = new Map(
    Object.entries(entries ?? {}).map(([key, value]) => [key, JSON.stringify(value)]),
  );

  context.capabilities.sql = {
    connection: {
      prepare(query: string) {
        return {
          bind(userId: string, roomId?: string, eventType?: string) {
            return {
              async first() {
                if (
                  query.includes("FROM account_data") &&
                  typeof roomId === "string" &&
                  typeof eventType === "string"
                ) {
                  const content = persisted.get(`${userId}:${roomId}:${eventType}`);
                  if (!content) {
                    return null;
                  }

                  return {
                    content,
                    deleted: 0,
                  };
                }

                return null;
              },
              async all() {
                return { results: [] };
              },
              async run() {
                if (
                  query.includes("INSERT INTO account_data") &&
                  typeof roomId === "string" &&
                  typeof eventType === "string"
                ) {
                  persisted.delete(`${userId}:${roomId}:${eventType}`);
                }
                return { success: true };
              },
            };
          },
        };
      },
    } as unknown as D1Database,
  };

  return context;
}

describe("MatrixSyncService", () => {
  it("preserves composite sync tokens and waits when idle", async () => {
    const repo = new FakeSyncRepository();
    const service = new MatrixSyncService(createTestAppContext(), repo);

    const response = await runClientEffect(
      service.syncUser({
        userId: "@alice:test",
        deviceId: null,
        since: "s2_td0",
        timeout: 2000,
      }),
    );

    expect(repo.waitCalls).toBe(1);
    expect(response.next_batch).toBe("s5_td0_dk7");
  });

  it("waits on incremental syncs even when the event stream position is zero", async () => {
    const repo = new FakeSyncRepository();
    const service = new MatrixSyncService(createTestAppContext(), repo);

    await runClientEffect(
      service.syncUser({
        userId: "@alice:test",
        deviceId: null,
        since: "s0_td0_dk0",
        timeout: 2000,
      }),
    );

    expect(repo.waitCalls).toBe(1);
  });

  it("projects invite rooms with a current leave state into rooms.leave", async () => {
    const repo = new FakeSyncRepository();
    const roomId = "!room:hs1";
    repo.inviteRooms = [roomId];
    repo.memberships.set(`${roomId}:@alice:test`, { membership: "invite", eventId: "$invite" });
    repo.roomStates.set(roomId, [
      {
        event_id: "$leave",
        room_id: roomId,
        sender: "@alice:test",
        type: "m.room.member",
        state_key: "@alice:test",
        content: { membership: "leave" },
        origin_server_ts: 10,
        depth: 1,
        auth_events: [],
        prev_events: [],
      },
    ]);

    const service = new MatrixSyncService(createTestAppContext(), repo);
    const response = await runClientEffect(
      service.syncUser({
        userId: "@alice:test",
        deviceId: null,
        since: "s1_td0_dk0",
      }),
    );

    expect(response.rooms?.invite?.[roomId]).toBeUndefined();
    expect(response.rooms?.leave?.[roomId]?.timeline?.events[0]).toMatchObject({
      event_id: "$leave",
      state_key: "@alice:test",
      content: { membership: "leave" },
    });
  });

  it("projects banned rooms into rooms.leave and removes stale join entries", async () => {
    const repo = new FakeSyncRepository();
    const roomId = "!room:hs1";
    repo.joinedRooms = [roomId];
    repo.memberships.set(`${roomId}:@alice:test`, { membership: "ban", eventId: "$ban" });
    repo.roomStates.set(roomId, [
      {
        event_id: "$ban",
        room_id: roomId,
        sender: "@bob:test",
        type: "m.room.member",
        state_key: "@alice:test",
        content: { membership: "ban" },
        origin_server_ts: 10,
        depth: 1,
        auth_events: [],
        prev_events: [],
      },
    ]);

    const service = new MatrixSyncService(createTestAppContext(), repo);
    const response = await runClientEffect(
      service.syncUser({
        userId: "@alice:test",
        deviceId: null,
        since: "s1_td0_dk0",
      }),
    );

    expect(response.rooms?.join?.[roomId]).toBeUndefined();
    expect(response.rooms?.leave?.[roomId]?.timeline?.events[0]).toMatchObject({
      event_id: "$ban",
      state_key: "@alice:test",
      content: { membership: "ban" },
    });
  });

  it("includes leave rooms on incremental syncs even when a room filter is present", async () => {
    const repo = new FakeSyncRepository();
    const roomId = "!room:hs1";
    repo.loadedFilter = {
      room: {
        timeline: {
          limit: 1,
        },
      },
    };
    repo.memberships.set(`${roomId}:@alice:test`, { membership: "leave", eventId: "$leave" });
    repo.eventsById.set("$leave", {
      event_id: "$leave",
      room_id: roomId,
      sender: "@alice:test",
      type: "m.room.member",
      state_key: "@alice:test",
      content: { membership: "leave" },
      origin_server_ts: 10,
      depth: 1,
      auth_events: [],
      prev_events: [],
    });

    const service = new MatrixSyncService(createTestAppContext(), repo);
    const response = await runClientEffect(
      service.syncUser({
        userId: "@alice:test",
        deviceId: null,
        since: "s1_td0_dk0",
        filterParam: "filter-id",
      }),
    );

    expect(response.rooms?.leave?.[roomId]?.timeline?.events[0]).toMatchObject({
      event_id: "$leave",
      content: { membership: "leave" },
    });
  });

  it("honors include_leave=false on incremental syncs with filters", async () => {
    const repo = new FakeSyncRepository();
    const roomId = "!room:hs1";
    repo.loadedFilter = {
      room: {
        include_leave: false,
      },
    };
    repo.memberships.set(`${roomId}:@alice:test`, { membership: "leave", eventId: "$leave" });
    repo.eventsById.set("$leave", {
      event_id: "$leave",
      room_id: roomId,
      sender: "@alice:test",
      type: "m.room.member",
      state_key: "@alice:test",
      content: { membership: "leave" },
      origin_server_ts: 10,
      depth: 1,
      auth_events: [],
      prev_events: [],
    });

    const service = new MatrixSyncService(createTestAppContext(), repo);
    const response = await runClientEffect(
      service.syncUser({
        userId: "@alice:test",
        deviceId: null,
        since: "s1_td0_dk0",
        filterParam: "filter-id",
      }),
    );

    expect(response.rooms?.leave?.[roomId]).toBeUndefined();
  });

  it("omits empty invite maps without crashing sync response projection", async () => {
    const repo = new FakeSyncRepository();
    const service = new MatrixSyncService(createTestAppContext(), repo);

    const response = await runClientEffect(
      service.syncUser({
        userId: "@alice:test",
        deviceId: null,
        since: "s1_td0_dk0",
        timeout: 1000,
      }),
    );

    expect(response.rooms?.invite).toBeUndefined();
    expect(response.rooms?.leave).toBeUndefined();
    expect(response.rooms?.knock).toBeUndefined();
  });

  it("omits unchanged joined rooms from incremental sync responses", async () => {
    const repo = new FakeSyncRepository();
    const roomId = "!room:hs1";
    repo.joinedRooms = [roomId];

    const service = new MatrixSyncService(createTestAppContext(), repo);
    const response = await runClientEffect(
      service.syncUser({
        userId: "@alice:test",
        deviceId: null,
        since: "s1_td0_dk0",
      }),
    );

    expect(response.rooms?.join?.[roomId]).toBeUndefined();
  });

  it("prefers leave membership events over earlier invite events in incremental leave syncs", async () => {
    const repo = new FakeSyncRepository();
    const roomId = "!room:hs1";
    const leaveEvent: PDU = {
      event_id: "$leave",
      room_id: roomId,
      sender: "@alice:test",
      type: "m.room.member",
      state_key: "@alice:test",
      content: { membership: "leave" },
      origin_server_ts: 20,
      depth: 2,
      auth_events: [],
      prev_events: ["$invite"],
    };
    repo.memberships.set(`${roomId}:@alice:test`, { membership: "leave", eventId: "$leave" });
    repo.eventsById.set("$leave", leaveEvent);
    repo.eventsSince.set(roomId, [
      {
        event_id: "$invite",
        room_id: roomId,
        sender: "@bob:hs1",
        type: "m.room.member",
        state_key: "@alice:test",
        content: { membership: "invite" },
        origin_server_ts: 10,
        depth: 1,
        auth_events: [],
        prev_events: [],
      },
      leaveEvent,
    ]);

    const service = new MatrixSyncService(createTestAppContext(), repo);
    const response = await runClientEffect(
      service.syncUser({
        userId: "@alice:test",
        deviceId: null,
        since: "s1_td0",
      }),
    );

    expect(response.rooms?.leave?.[roomId]?.timeline?.events[0]).toMatchObject({
      event_id: "$leave",
      content: { membership: "leave" },
    });
  });

  it("omits forgotten rooms from initial leave syncs", async () => {
    const repo = new FakeSyncRepository();
    const roomId = "!room:hs1";
    const leaveEvent: PDU = {
      event_id: "$leave",
      room_id: roomId,
      sender: "@alice:test",
      type: "m.room.member",
      state_key: "@alice:test",
      content: { membership: "leave" },
      origin_server_ts: 20,
      depth: 2,
      auth_events: [],
      prev_events: [],
    };
    repo.memberships.set(`${roomId}:@alice:test`, { membership: "leave", eventId: "$leave" });
    repo.eventsById.set("$leave", leaveEvent);
    repo.roomAccountData.set(roomId, [
      {
        type: FORGOTTEN_ROOM_ACCOUNT_DATA_TYPE,
        content: { forgotten: true },
      },
    ]);

    const service = new MatrixSyncService(createTestAppContext(), repo);
    const response = await runClientEffect(
      service.syncUser({
        userId: "@alice:test",
        deviceId: null,
        since: undefined,
        filterParam: JSON.stringify({
          room: {
            include_leave: true,
          },
        }),
      }),
    );

    expect(response.rooms?.leave?.[roomId]).toBeUndefined();
  });

  it("hides partial-state joined rooms from eager sync but keeps them for lazy-loading syncs", async () => {
    const repo = new FakeSyncRepository();
    const roomId = "!room:hs1";
    repo.eventsSince.set(roomId, []);
    repo.roomStates.set(roomId, []);
    repo.getUserRooms = async (
      _userId?: string,
      membership?: "join" | "invite" | "leave" | "ban" | "knock",
    ) => {
      if (membership === "join") {
        return [roomId];
      }
      return [];
    };

    const service = new MatrixSyncService(
      createCacheBackedAppContext({
        "partial_state_join:@alice:test:!room:hs1": {
          roomId,
          userId: "@alice:test",
          eventId: "$prev",
          startedAt: 1,
        },
      }),
      repo,
    );

    const eager = await runClientEffect(
      service.syncUser({
        userId: "@alice:test",
        deviceId: null,
        since: "s1_td0_dk0",
      }),
    );
    expect(eager.rooms?.join?.[roomId]).toBeUndefined();

    const lazy = await runClientEffect(
      service.syncUser({
        userId: "@alice:test",
        deviceId: null,
        since: "s1_td0_dk0",
        filterParam: JSON.stringify({
          room: {
            timeline: { lazy_load_members: true },
            state: { lazy_load_members: true },
          },
        }),
      }),
    );
    expect(lazy.rooms?.join?.[roomId]).toBeDefined();
  });

  it("keeps hidden partial-state rooms out of eager incremental sync until completion", async () => {
    const repo = new FakeSyncRepository();
    const roomId = "!room:hs1";
    repo.joinedRooms = [roomId];
    repo.eventsSince.set(roomId, [
      {
        event_id: "$message",
        room_id: roomId,
        sender: "@charlie:remote",
        type: "m.room.message",
        content: { body: "hi", msgtype: "m.text" },
        origin_server_ts: 10,
        depth: 1,
        auth_events: [],
        prev_events: [],
      },
    ]);

    const service = new MatrixSyncService(
      createCacheBackedAppContext({
        "partial_state_join:@alice:test:!room:hs1": {
          roomId,
          userId: "@alice:test",
          eventId: "$prev",
          startedAt: 1,
        },
      }),
      repo,
    );

    const response = await runClientEffect(
      service.syncUser({
        userId: "@alice:test",
        deviceId: null,
        since: "s1_td0_dk0",
      }),
    );

    expect(response.rooms?.join?.[roomId]).toBeUndefined();
  });

  it("returns full room state on the first sync after partial-state completion", async () => {
    const repo = new FakeSyncRepository();
    const roomId = "!room:hs1";
    repo.getUserRooms = async (
      _userId?: string,
      membership?: "join" | "invite" | "leave" | "ban" | "knock",
    ) => {
      if (membership === "join") {
        return [roomId];
      }
      return [];
    };
    repo.roomStates.set(roomId, [
      {
        event_id: "$charlie",
        room_id: roomId,
        sender: "@charlie:remote",
        type: "m.room.member",
        state_key: "@charlie:remote",
        content: { membership: "join" },
        origin_server_ts: 10,
        depth: 1,
        auth_events: [],
        prev_events: [],
      },
    ]);

    const service = new MatrixSyncService(
      createCacheBackedAppContext({
        "partial_state_completed:@alice:test:!room:hs1": {
          roomId,
          userId: "@alice:test",
          eventId: "$prev",
          startedAt: 1,
        },
      }),
      repo,
    );

    const response = await runClientEffect(
      service.syncUser({
        userId: "@alice:test",
        deviceId: null,
        since: "s5_td0_dk0",
      }),
    );

    expect(response.rooms?.join?.[roomId]?.state?.events).toEqual([
      expect.objectContaining({
        event_id: "$charlie",
        type: "m.room.member",
        state_key: "@charlie:remote",
      }),
    ]);
  });

  it("falls back to persisted completion metadata when cache completion markers are gone", async () => {
    const repo = new FakeSyncRepository();
    const roomId = "!room:hs1";
    repo.joinedRooms = [roomId];
    repo.roomStates.set(roomId, [
      {
        event_id: "$charlie",
        room_id: roomId,
        sender: "@charlie:remote",
        type: "m.room.member",
        state_key: "@charlie:remote",
        content: { membership: "join" },
        origin_server_ts: 10,
        depth: 1,
        auth_events: [],
        prev_events: [],
      },
    ]);

    const service = new MatrixSyncService(
      createPersistedPartialStateAppContext({
        "@alice:test:!room:hs1:io.tuwunel.partial_state_join": {
          roomId,
          userId: "@alice:test",
          eventId: "$prev",
          startedAt: 1,
          phase: "complete",
          completedAt: 2,
        },
      }),
      repo,
    );

    const response = await runClientEffect(
      service.syncUser({
        userId: "@alice:test",
        deviceId: null,
        since: "s5_td0_dk0",
      }),
    );

    expect(response.rooms?.join?.[roomId]?.state?.events).toEqual([
      expect.objectContaining({
        event_id: "$charlie",
        type: "m.room.member",
      }),
    ]);
  });
});
