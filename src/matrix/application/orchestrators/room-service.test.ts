import { describe, expect, it } from "vitest";
import type { AppContext } from "../../../shared/runtime/app-context";
import { createFeatureProfile } from "../../../shared/config/feature-profile";
import { DefaultEventPipeline } from "../../domain/event-pipeline";
import { MatrixRoomService } from "./room-service";
import type { MembershipRecord, RoomRepository } from "../../../infra/repositories/interfaces";
import type {
  PDU,
  Room,
  RoomJoinWorkflowParams,
  RoomJoinWorkflowStatus,
} from "../../../shared/types";

class MemoryIdempotencyStore {
  private readonly entries = new Map<string, Record<string, unknown>>();

  get(scope: string, key: string): Promise<Record<string, unknown> | null> {
    return this.entries.get(`${scope}:${key}`) ?? null;
  }

  put(scope: string, key: string, value: Record<string, unknown>): Promise<void> {
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

  getRoomByAlias(alias: string): Promise<string | null> {
    return this.roomAliases.get(alias) ?? null;
  }

  createRoom(
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

  createRoomAlias(alias: string, roomId: string): Promise<void> {
    this.roomAliases.set(alias, roomId);
  }

  upsertRoomAccountData(
    userId: string,
    roomId: string,
    eventType: string,
    content: Record<string, unknown>,
  ): Promise<void> {
    this.accountData.set(`${userId}:${roomId}:${eventType}`, content);
  }

  storeEvent(event: PDU): Promise<void> {
    this.storedEvents.push(event);
    if (event.state_key !== undefined) {
      this.stateEvents.set(this.stateKey(event.room_id, event.type, event.state_key), event);
    }
  }

  async persistMembershipEvent(roomId: string, event: PDU): Promise<void> {
    await this.storeEvent(event);
    if (event.state_key !== undefined) {
      const content = event.content as { membership?: MembershipRecord["membership"] } | undefined;
      if (content?.membership) {
        await this.updateMembership(roomId, event.state_key, content.membership, event.event_id);
      }
    }
  }

  updateMembership(
    roomId: string,
    userId: string,
    membership: MembershipRecord["membership"],
    eventId: string,
  ): Promise<void> {
    this.memberships.set(this.membershipKey(roomId, userId), { membership, eventId });
  }

  notifyUsersOfEvent(): Promise<void> {
    this.notifyCount += 1;
  }

  getRoom(roomId: string): Promise<Room | null> {
    return this.rooms.get(roomId) ?? null;
  }

  getEvent(eventId: string): Promise<PDU | null> {
    return this.storedEvents.find((event) => event.event_id === eventId) ?? null;
  }

  getMembership(roomId: string, userId: string): Promise<MembershipRecord | null> {
    return this.memberships.get(this.membershipKey(roomId, userId)) ?? null;
  }

  async getStateEvent(
    roomId: string,
    eventType: string,
    stateKey: string = "",
  ): Promise<PDU | null> {
    return this.stateEvents.get(this.stateKey(roomId, eventType, stateKey)) ?? null;
  }

  getLatestRoomEvents(roomId: string, limit: number): Promise<PDU[]> {
    return this.storedEvents
      .filter((event) => event.room_id === roomId)
      .slice(-limit)
      .toReversed();
  }
}

function createTestAppContext(
  roomJoinStatus: RoomJoinWorkflowStatus = { status: "complete", output: { success: true } },
) {
  let eventCounter = 0;
  let roomCounter = 0;
  const pushCalls: Array<Record<string, unknown>> = [];
  const roomJoinCalls: RoomJoinWorkflowParams[] = [];
  const deferredTasks: Promise<unknown>[] = [];

  const appContext = {
    profile: createFeatureProfile("full"),
    capabilities: {
      sql: { connection: {} },
      kv: {},
      blob: {},
      jobs: { defer: (_task: Promise<unknown>) => {} },
      workflow: {
        createRoomJoin(params: RoomJoinWorkflowParams) {
          roomJoinCalls.push(params);
          return roomJoinStatus;
        },
        createPushNotification(params: unknown) {
          pushCalls.push(params as Record<string, unknown>);
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
      clock: { now: () => 1_700_000_000_000 },
      id: {
        generateRoomId(serverName: string) {
          roomCounter += 1;
          return `!room${roomCounter}:${serverName}`;
        },
        generateEventId() {
          eventCounter += 1;
          return `$event${eventCounter}`;
        },
        generateOpaqueId() {
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
      deferredTasks.push(task);
    },
  } satisfies AppContext;

  return { appContext, pushCalls, roomJoinCalls, deferredTasks };
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

  it("includes creation_content in the create event", async () => {
    const repo = new MemoryRoomRepository();
    const { appContext } = createTestAppContext();
    const service = new MatrixRoomService(
      appContext,
      repo,
      new DefaultEventPipeline(),
      new MemoryIdempotencyStore(),
    );

    await service.createRoom({
      userId: "@alice:test",
      body: {
        creation_content: {
          "m.federate": false,
        },
      },
    });

    expect(
      repo.storedEvents.find((event) => event.type === "m.room.create")?.content,
    ).toMatchObject({
      creator: "@alice:test",
      room_version: "10",
      "m.federate": false,
    });
  });

  it("applies top-level topic after initial_state and writes rich topic content", async () => {
    const repo = new MemoryRoomRepository();
    const { appContext } = createTestAppContext();
    const service = new MatrixRoomService(
      appContext,
      repo,
      new DefaultEventPipeline(),
      new MemoryIdempotencyStore(),
    );

    await service.createRoom({
      userId: "@alice:test",
      body: {
        topic: "Test Room",
        initial_state: [
          {
            type: "m.room.topic",
            state_key: "",
            content: { topic: "Shenanigans" },
          },
        ],
      },
    });

    void expect(repo.getStateEvent("!room1:test", "m.room.topic", "")).resolves.toMatchObject({
      content: {
        topic: "Test Room",
        "m.topic": {
          "m.text": [{ body: "Test Room" }],
        },
      },
    });
  });

  it("handles local knocking through the room service boundary", async () => {
    const repo = new MemoryRoomRepository();
    const { appContext } = createTestAppContext();
    const service = new MatrixRoomService(
      appContext,
      repo,
      new DefaultEventPipeline(),
      new MemoryIdempotencyStore(),
    );

    await repo.createRoom("!room1:test", "10", "@alice:test", false);
    await repo.storeEvent({
      event_id: "$create",
      room_id: "!room1:test",
      sender: "@alice:test",
      type: "m.room.create",
      state_key: "",
      content: {
        creator: "@alice:test",
        room_version: "10",
      },
      origin_server_ts: 1,
      depth: 1,
      auth_events: [],
      prev_events: [],
    });
    await repo.storeEvent({
      event_id: "$join_rules",
      room_id: "!room1:test",
      sender: "@alice:test",
      type: "m.room.join_rules",
      state_key: "",
      content: { join_rule: "knock" },
      origin_server_ts: 2,
      depth: 2,
      auth_events: ["$create"],
      prev_events: ["$create"],
    });
    await repo.updateMembership("!room1:test", "@alice:test", "join", "$alice_member");
    await repo.storeEvent({
      event_id: "$alice_member",
      room_id: "!room1:test",
      sender: "@alice:test",
      type: "m.room.member",
      state_key: "@alice:test",
      content: { membership: "join" },
      origin_server_ts: 3,
      depth: 3,
      auth_events: ["$create", "$join_rules"],
      prev_events: ["$join_rules"],
    });

    const response = await service.knockRoom({
      userId: "@bob:test",
      roomId: "!room1:test",
      reason: "let me in",
    });

    expect(response).toEqual({ room_id: "!room1:test" });
    expect(repo.memberships.get("!room1:test:@bob:test")).toMatchObject({
      membership: "knock",
    });
    expect(repo.notifyCount).toBe(1);
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

  it("preserves custom join content on local joins", async () => {
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

    await service.joinRoom({
      userId: "@alice:test",
      roomId: "!room1:test",
      body: { foo: "bar", membership: "leave" },
    });

    expect(repo.memberships.get("!room1:test:@alice:test")?.membership).toBe("join");
    expect(repo.storedEvents.at(-1)).toMatchObject({
      type: "m.room.member",
      state_key: "@alice:test",
      content: { foo: "bar", membership: "join" },
    });
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

  it("maps remote workflow join failures back to Matrix errors", async () => {
    const repo = new MemoryRoomRepository();
    const { appContext } = createTestAppContext({
      status: "complete",
      output: {
        success: false,
        error: "Cannot join room without an invite",
        errorStatus: 403,
        errorErrcode: "M_FORBIDDEN",
      },
    });

    const service = new MatrixRoomService(
      appContext,
      repo,
      new DefaultEventPipeline(),
      new MemoryIdempotencyStore(),
    );

    await expect(
      service.joinRoom({
        userId: "@alice:test",
        roomId: "!room1:remote.test",
      }),
    ).rejects.toThrow("Cannot join room without an invite");
  });

  it("rejects restricted joins when no allowed rooms are configured", async () => {
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
    ).rejects.toThrow("Restricted room has no allowed rooms configured");
  });

  it("rejects restricted joins when user is not in any allowed room", async () => {
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
      content: {
        join_rule: "restricted",
        allow: [{ type: "m.room_membership", room_id: "!prereq:test" }],
      },
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

    // alice is NOT in !prereq:test, so join should be denied
    await expect(
      service.joinRoom({ userId: "@alice:test", roomId: "!room1:test" }),
    ).rejects.toThrow("Not a member of any allowed room for this restricted room");
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

  it("treats repeated leave requests as a no-op", async () => {
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
      event_id: "$leave",
      room_id: "!room1:test",
      sender: "@alice:test",
      type: "m.room.member",
      state_key: "@alice:test",
      content: { membership: "leave" },
      origin_server_ts: 3,
      depth: 3,
      auth_events: ["$create", "$power"],
      prev_events: ["$power"],
    });
    await repo.updateMembership("!room1:test", "@alice:test", "leave", "$leave");

    const service = new MatrixRoomService(
      appContext,
      repo,
      new DefaultEventPipeline(),
      new MemoryIdempotencyStore(),
    );
    const initialEventCount = repo.storedEvents.length;

    await service.leaveRoom({ userId: "@alice:test", roomId: "!room1:test" });

    expect(repo.memberships.get("!room1:test:@alice:test")?.membership).toBe("leave");
    expect(repo.storedEvents).toHaveLength(initialEventCount);
  });

  it("invites a user through the membership persistence boundary", async () => {
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
      content: { invite: 0, users: { "@alice:test": 50 } },
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

    await service.inviteRoom({
      userId: "@alice:test",
      roomId: "!room1:test",
      targetUserId: "@bob:remote.test",
    });

    expect(repo.memberships.get("!room1:test:@bob:remote.test")?.membership).toBe("invite");
    expect(repo.storedEvents.at(-1)).toMatchObject({
      type: "m.room.member",
      state_key: "@bob:remote.test",
      sender: "@alice:test",
      content: { membership: "invite" },
    });
  });

  it("kicks an invited user through the moderation boundary", async () => {
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
      content: { kick: 50, users: { "@alice:test": 100, "@bob:test": 0 } },
      origin_server_ts: 2,
      depth: 2,
      auth_events: [],
      prev_events: ["$create"],
    });
    await repo.storeEvent({
      event_id: "$alice-member",
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
    await repo.storeEvent({
      event_id: "$invite",
      room_id: "!room1:test",
      sender: "@alice:test",
      type: "m.room.member",
      state_key: "@bob:test",
      content: { membership: "invite" },
      origin_server_ts: 4,
      depth: 4,
      auth_events: ["$create", "$power", "$alice-member"],
      prev_events: ["$alice-member"],
    });
    await repo.updateMembership("!room1:test", "@alice:test", "join", "$alice-member");
    await repo.updateMembership("!room1:test", "@bob:test", "invite", "$invite");

    const service = new MatrixRoomService(
      appContext,
      repo,
      new DefaultEventPipeline(),
      new MemoryIdempotencyStore(),
    );

    await service.kickUser({
      userId: "@alice:test",
      roomId: "!room1:test",
      targetUserId: "@bob:test",
      reason: "cleanup",
    });

    expect(repo.memberships.get("!room1:test:@bob:test")?.membership).toBe("leave");
    expect(repo.storedEvents.at(-1)).toMatchObject({
      state_key: "@bob:test",
      sender: "@alice:test",
      content: { membership: "leave", reason: "cleanup" },
    });
  });

  it("bans and unbans a user through the moderation boundary", async () => {
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
      content: { ban: 50, users: { "@alice:test": 100, "@bob:test": 0 } },
      origin_server_ts: 2,
      depth: 2,
      auth_events: [],
      prev_events: ["$create"],
    });
    await repo.storeEvent({
      event_id: "$alice-member",
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
    await repo.storeEvent({
      event_id: "$bob-member",
      room_id: "!room1:test",
      sender: "@bob:test",
      type: "m.room.member",
      state_key: "@bob:test",
      content: { membership: "join" },
      origin_server_ts: 4,
      depth: 4,
      auth_events: ["$create", "$power"],
      prev_events: ["$alice-member"],
    });
    await repo.updateMembership("!room1:test", "@alice:test", "join", "$alice-member");
    await repo.updateMembership("!room1:test", "@bob:test", "join", "$bob-member");

    const service = new MatrixRoomService(
      appContext,
      repo,
      new DefaultEventPipeline(),
      new MemoryIdempotencyStore(),
    );

    await service.banUser({
      userId: "@alice:test",
      roomId: "!room1:test",
      targetUserId: "@bob:test",
      reason: "policy",
    });
    expect(repo.memberships.get("!room1:test:@bob:test")?.membership).toBe("ban");

    await service.unbanUser({
      userId: "@alice:test",
      roomId: "!room1:test",
      targetUserId: "@bob:test",
      reason: "appeal",
    });
    expect(repo.memberships.get("!room1:test:@bob:test")?.membership).toBe("leave");
    expect(repo.storedEvents.at(-1)).toMatchObject({
      state_key: "@bob:test",
      content: { membership: "leave", reason: "appeal" },
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
    expect(first.event_id).not.toBe("$event1");
    expect(
      repo.storedEvents.find((event) => event.type === "m.room.message")?.hashes?.sha256,
    ).toBeDefined();
    expect(pushCalls).toHaveLength(1);
  });

  it("deduplicates state events by current state content", async () => {
    const repo = new MemoryRoomRepository();
    const { appContext } = createTestAppContext();
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

    const existingStateEvent: PDU = {
      event_id: "$topic-1",
      room_id: "!room1:test",
      sender: "@alice:test",
      type: "m.room.topic",
      state_key: "",
      content: { topic: "same" },
      origin_server_ts: 3,
      depth: 3,
      auth_events: ["$create", "$power", "$member"],
      prev_events: ["$power"],
    };
    await repo.storeEvent(existingStateEvent);

    const service = new MatrixRoomService(
      appContext,
      repo,
      new DefaultEventPipeline(),
      new MemoryIdempotencyStore(),
    );

    const response = await service.sendEvent({
      userId: "@alice:test",
      roomId: "!room1:test",
      eventType: "m.room.topic",
      stateKey: "",
      txnId: "txn-state-1",
      content: { topic: "same" },
    });

    expect(response).toEqual({ event_id: "$topic-1" });
    expect(repo.storedEvents.filter((event) => event.type === "m.room.topic")).toHaveLength(1);
  });

  it("rejects reserved user state keys for other users in stable v10 rooms", async () => {
    const repo = new MemoryRoomRepository();
    const { appContext } = createTestAppContext();
    await repo.createRoom("!room1:test", "10", "@creator:test", true);
    await repo.updateMembership("!room1:test", "@creator:test", "join", "$creator-member");
    await repo.updateMembership("!room1:test", "@alice:test", "join", "$alice-member");
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
      content: {
        events: { "com.example.test": 0 },
        users: { "@creator:test": 100, "@alice:test": 0 },
        users_default: 0,
        state_default: 50,
      },
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

    await expect(
      service.sendEvent({
        userId: "@creator:test",
        roomId: "!room1:test",
        eventType: "com.example.test",
        stateKey: "@alice:test",
        txnId: "txn-owned-stable",
        content: {},
      }),
    ).rejects.toThrow("reserved");
  });

  it("allows privileged writes to suffixed owned state in MSC3757 rooms", async () => {
    const repo = new MemoryRoomRepository();
    const { appContext } = createTestAppContext();
    await repo.createRoom("!room1:test", "org.matrix.msc3757.10", "@creator:test", true);
    await repo.updateMembership("!room1:test", "@creator:test", "join", "$creator-member");
    await repo.updateMembership("!room1:test", "@alice:test", "join", "$alice-member");
    await repo.storeEvent({
      event_id: "$create",
      room_id: "!room1:test",
      sender: "@creator:test",
      type: "m.room.create",
      state_key: "",
      content: { creator: "@creator:test", room_version: "org.matrix.msc3757.10" },
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
      content: {
        events: { "com.example.test": 0 },
        users: { "@creator:test": 100, "@alice:test": 0 },
        users_default: 0,
        state_default: 50,
      },
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

    await expect(
      service.sendEvent({
        userId: "@creator:test",
        roomId: "!room1:test",
        eventType: "com.example.test",
        stateKey: "@alice:test_state_key_suffix:!@#$123",
        txnId: "txn-owned-unstable",
        content: {},
      }),
    ).resolves.toMatchObject({ event_id: expect.any(String) });
  });
});
