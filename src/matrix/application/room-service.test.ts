import { describe, expect, it } from "vitest";
import type { AppContext } from "../../foundation/app-context";
import { createFeatureProfile } from "../../foundation/config/feature-profile";
import { DefaultEventPipeline } from "../domain/event-pipeline";
import { MatrixRoomService } from "./room-service";
import type { MembershipRecord, RoomRepository } from "../repositories/interfaces";
import type { PDU, Room } from "../../types";

class MemoryIdempotencyStore {
  private readonly entries = new Map<string, Record<string, unknown>>();

  async get(scope: string, key: string): Promise<Record<string, unknown> | null> {
    return this.entries.get(`${scope}:${key}`) ?? null;
  }

  async put(scope: string, key: string, value: Record<string, unknown>): Promise<void> {
    this.entries.set(`${scope}:${key}`, value);
  }
}

class MemoryRoomRepository implements RoomRepository {
  readonly roomAliases = new Map<string, string>();
  readonly rooms = new Map<string, Room>();
  readonly memberships = new Map<string, MembershipRecord>();
  readonly stateEvents = new Map<string, PDU>();
  readonly storedEvents: PDU[] = [];
  readonly accountData = new Map<string, Record<string, unknown>>();
  notifyCount = 0;

  private membershipKey(roomId: string, userId: string): string {
    return `${roomId}:${userId}`;
  }

  private stateKey(roomId: string, eventType: string, stateKey: string = ""): string {
    return `${roomId}:${eventType}:${stateKey}`;
  }

  async getRoomByAlias(alias: string): Promise<string | null> {
    return this.roomAliases.get(alias) ?? null;
  }

  async createRoom(
    roomId: string,
    roomVersion: string,
    creatorId: string,
    isPublic: boolean,
  ): Promise<void> {
    this.rooms.set(roomId, {
      room_id: roomId,
      room_version: roomVersion,
      is_public: isPublic,
      creator_id: creatorId,
      created_at: Date.now(),
    });
  }

  async createRoomAlias(alias: string, roomId: string): Promise<void> {
    this.roomAliases.set(alias, roomId);
  }

  async upsertRoomAccountData(
    userId: string,
    roomId: string,
    eventType: string,
    content: Record<string, unknown>,
  ): Promise<void> {
    this.accountData.set(`${userId}:${roomId}:${eventType}`, content);
  }

  async storeEvent(event: PDU): Promise<void> {
    this.storedEvents.push(event);
    if (event.state_key !== undefined) {
      this.stateEvents.set(this.stateKey(event.room_id, event.type, event.state_key), event);
    }
  }

  async persistMembershipEvent(
    roomId: string,
    event: PDU,
  ): Promise<void> {
    await this.storeEvent(event);
    if (event.state_key !== undefined) {
      const content = event.content as { membership?: MembershipRecord["membership"] } | undefined;
      if (content?.membership) {
        await this.updateMembership(roomId, event.state_key, content.membership, event.event_id);
      }
    }
  }

  async updateMembership(
    roomId: string,
    userId: string,
    membership: MembershipRecord["membership"],
    eventId: string,
  ): Promise<void> {
    this.memberships.set(this.membershipKey(roomId, userId), { membership, eventId });
  }

  async notifyUsersOfEvent(): Promise<void> {
    this.notifyCount += 1;
  }

  async getRoom(roomId: string): Promise<Room | null> {
    return this.rooms.get(roomId) ?? null;
  }

  async getMembership(roomId: string, userId: string): Promise<MembershipRecord | null> {
    return this.memberships.get(this.membershipKey(roomId, userId)) ?? null;
  }

  async getStateEvent(
    roomId: string,
    eventType: string,
    stateKey: string = "",
  ): Promise<PDU | null> {
    return this.stateEvents.get(this.stateKey(roomId, eventType, stateKey)) ?? null;
  }

  async getLatestRoomEvents(roomId: string, limit: number): Promise<PDU[]> {
    return this.storedEvents
      .filter((event) => event.room_id === roomId)
      .slice(-limit)
      .reverse();
  }
}

function createTestAppContext() {
  let eventCounter = 0;
  let roomCounter = 0;
  const pushCalls: Array<Record<string, unknown>> = [];
  const roomJoinCalls: Array<Record<string, unknown>> = [];

  const appContext = {
    profile: createFeatureProfile("full"),
    capabilities: {
      sql: { connection: {} },
      kv: {},
      blob: {},
      jobs: { defer: (_task: Promise<unknown>) => undefined },
      workflow: {
        async createRoomJoin(params: unknown) {
          roomJoinCalls.push(params as Record<string, unknown>);
          return { status: "complete", output: { success: true } };
        },
        async createPushNotification(params: unknown) {
          pushCalls.push(params as Record<string, unknown>);
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
        async generateRoomId(serverName: string) {
          roomCounter += 1;
          return `!room${roomCounter}:${serverName}`;
        },
        async generateEventId() {
          eventCounter += 1;
          return `$event${eventCounter}`;
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
        serverVersion: "0.1.0",
      },
    },
    services: {},
    defer(task: Promise<unknown>) {
      void task;
    },
  } satisfies AppContext;

  return { appContext, pushCalls, roomJoinCalls };
}

describe("MatrixRoomService", () => {
  it("creates a room through the repository boundary", async () => {
    const repo = new MemoryRoomRepository();
    const { appContext } = createTestAppContext();
    const service = new MatrixRoomService(
      appContext,
      repo,
      new DefaultEventPipeline(),
      new MemoryIdempotencyStore(),
    );

    const response = await service.createRoom({
      userId: "@alice:test",
      body: {
        room_alias_local_part: "general",
        visibility: "public",
        initial_state: [],
      },
    });

    expect(response.room_id).toBe("!room1:test");
    expect(response.room_alias).toBe("#general:test");
    expect(repo.rooms.get("!room1:test")?.is_public).toBe(true);
    expect(repo.accountData.get("@alice:test:!room1:test:m.fully_read")).toBeDefined();
    expect(repo.notifyCount).toBeGreaterThan(0);
  });

  it("joins a public room through the event pipeline", async () => {
    const repo = new MemoryRoomRepository();
    const { appContext } = createTestAppContext();
    await repo.createRoom("!room1:test", "10", "@creator:test", true);
    await repo.storeEvent({
      event_id: "$create",
      room_id: "!room1:test",
      sender: "@creator:test",
      type: "m.room.create",
      state_key: "",
      content: { creator: "@creator:test", room_version: "10" },
      origin_server_ts: 1,
      depth: 1,
      auth_events: [],
      prev_events: [],
    });
    await repo.storeEvent({
      event_id: "$joinrules",
      room_id: "!room1:test",
      sender: "@creator:test",
      type: "m.room.join_rules",
      state_key: "",
      content: { join_rule: "public" },
      origin_server_ts: 2,
      depth: 2,
      auth_events: [],
      prev_events: ["$create"],
    });
    await repo.storeEvent({
      event_id: "$power",
      room_id: "!room1:test",
      sender: "@creator:test",
      type: "m.room.power_levels",
      state_key: "",
      content: {},
      origin_server_ts: 3,
      depth: 3,
      auth_events: [],
      prev_events: ["$joinrules"],
    });

    const service = new MatrixRoomService(
      appContext,
      repo,
      new DefaultEventPipeline(),
      new MemoryIdempotencyStore(),
    );
    const response = await service.joinRoom({ userId: "@alice:test", roomId: "!room1:test" });

    expect(response).toEqual({ room_id: "!room1:test" });
    expect(repo.memberships.get("!room1:test:@alice:test")?.membership).toBe("join");
  });

  it("uses the federation join workflow for remote invite stubs without create state", async () => {
    const repo = new MemoryRoomRepository();
    const { appContext, roomJoinCalls } = createTestAppContext();
    await repo.createRoom("!room1:remote.test", "10", "@creator:remote.test", false);
    await repo.updateMembership("!room1:remote.test", "@alice:test", "invite", "$invite");

    const service = new MatrixRoomService(
      appContext,
      repo,
      new DefaultEventPipeline(),
      new MemoryIdempotencyStore(),
    );

    const response = await service.joinRoom({
      userId: "@alice:test",
      roomId: "!room1:remote.test",
    });

    expect(response).toEqual({ room_id: "!room1:remote.test" });
    expect(roomJoinCalls).toHaveLength(1);
    expect(roomJoinCalls[0]).toMatchObject({
      roomId: "!room1:remote.test",
      userId: "@alice:test",
      isRemote: true,
      remoteServer: "remote.test",
    });
    expect(repo.memberships.get("!room1:remote.test:@alice:test")?.membership).toBe("invite");
  });

  it("rejects restricted joins without explicit authorization", async () => {
    const repo = new MemoryRoomRepository();
    const { appContext } = createTestAppContext();
    await repo.createRoom("!room1:test", "10", "@creator:test", false);
    await repo.storeEvent({
      event_id: "$create",
      room_id: "!room1:test",
      sender: "@creator:test",
      type: "m.room.create",
      state_key: "",
      content: { creator: "@creator:test", room_version: "10" },
      origin_server_ts: 1,
      depth: 1,
      auth_events: [],
      prev_events: [],
    });
    await repo.storeEvent({
      event_id: "$joinrules",
      room_id: "!room1:test",
      sender: "@creator:test",
      type: "m.room.join_rules",
      state_key: "",
      content: { join_rule: "restricted" },
      origin_server_ts: 2,
      depth: 2,
      auth_events: [],
      prev_events: ["$create"],
    });
    await repo.storeEvent({
      event_id: "$power",
      room_id: "!room1:test",
      sender: "@creator:test",
      type: "m.room.power_levels",
      state_key: "",
      content: {},
      origin_server_ts: 3,
      depth: 3,
      auth_events: [],
      prev_events: ["$joinrules"],
    });

    const service = new MatrixRoomService(
      appContext,
      repo,
      new DefaultEventPipeline(),
      new MemoryIdempotencyStore(),
    );

    await expect(
      service.joinRoom({ userId: "@alice:test", roomId: "!room1:test" }),
    ).rejects.toThrow("Cannot join restricted room without authorization");
  });

  it("leaves a joined room through the membership persistence boundary", async () => {
    const repo = new MemoryRoomRepository();
    const { appContext } = createTestAppContext();
    await repo.createRoom("!room1:test", "10", "@creator:test", true);
    await repo.storeEvent({
      event_id: "$create",
      room_id: "!room1:test",
      sender: "@creator:test",
      type: "m.room.create",
      state_key: "",
      content: { creator: "@creator:test", room_version: "10" },
      origin_server_ts: 1,
      depth: 1,
      auth_events: [],
      prev_events: [],
    });
    await repo.storeEvent({
      event_id: "$power",
      room_id: "!room1:test",
      sender: "@creator:test",
      type: "m.room.power_levels",
      state_key: "",
      content: {},
      origin_server_ts: 2,
      depth: 2,
      auth_events: [],
      prev_events: ["$create"],
    });
    await repo.storeEvent({
      event_id: "$member",
      room_id: "!room1:test",
      sender: "@alice:test",
      type: "m.room.member",
      state_key: "@alice:test",
      content: { membership: "join" },
      origin_server_ts: 3,
      depth: 3,
      auth_events: ["$create", "$power"],
      prev_events: ["$power"],
    });
    await repo.updateMembership("!room1:test", "@alice:test", "join", "$member");

    const service = new MatrixRoomService(
      appContext,
      repo,
      new DefaultEventPipeline(),
      new MemoryIdempotencyStore(),
    );

    await service.leaveRoom({ userId: "@alice:test", roomId: "!room1:test" });

    expect(repo.memberships.get("!room1:test:@alice:test")?.membership).toBe("leave");
    expect(repo.storedEvents.at(-1)).toMatchObject({
      type: "m.room.member",
      state_key: "@alice:test",
      content: { membership: "leave" },
    });
  });

  it("deduplicates sendEvent by txn id", async () => {
    const repo = new MemoryRoomRepository();
    const { appContext, pushCalls } = createTestAppContext();
    await repo.createRoom("!room1:test", "10", "@creator:test", true);
    await repo.updateMembership("!room1:test", "@alice:test", "join", "$member");
    await repo.storeEvent({
      event_id: "$create",
      room_id: "!room1:test",
      sender: "@creator:test",
      type: "m.room.create",
      state_key: "",
      content: { creator: "@creator:test", room_version: "10" },
      origin_server_ts: 1,
      depth: 1,
      auth_events: [],
      prev_events: [],
    });
    await repo.storeEvent({
      event_id: "$power",
      room_id: "!room1:test",
      sender: "@creator:test",
      type: "m.room.power_levels",
      state_key: "",
      content: {},
      origin_server_ts: 2,
      depth: 2,
      auth_events: [],
      prev_events: ["$create"],
    });

    const service = new MatrixRoomService(
      appContext,
      repo,
      new DefaultEventPipeline(),
      new MemoryIdempotencyStore(),
    );

    const first = await service.sendEvent({
      userId: "@alice:test",
      roomId: "!room1:test",
      eventType: "m.room.message",
      txnId: "txn-1",
      content: { body: "hi", msgtype: "m.text" },
    });
    const second = await service.sendEvent({
      userId: "@alice:test",
      roomId: "!room1:test",
      eventType: "m.room.message",
      txnId: "txn-1",
      content: { body: "hi", msgtype: "m.text" },
    });

    expect(first).toEqual(second);
    expect(repo.storedEvents.filter((event) => event.type === "m.room.message")).toHaveLength(1);
    expect(pushCalls).toHaveLength(1);
  });
});
