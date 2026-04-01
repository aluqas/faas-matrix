import { describe, expect, it } from "vitest";
import type { SyncRepository } from "../repositories/interfaces";
import type { PDU } from "../../types";
import {
  projectDeviceLists,
  projectGlobalAccountData,
  projectJoinedRoom,
  projectMembershipRooms,
} from "./sync-projection";

class FakeSyncRepository implements SyncRepository {
  memberships = new Map<
    string,
    { membership: "invite" | "join" | "leave" | "ban" | "knock"; eventId: string }
  >();
  roomStates = new Map<string, PDU[]>();
  inviteStates = new Map<
    string,
    Array<{ type: string; state_key: string; content: any; sender: string }>
  >();
  inviteRooms: string[] = [];
  knockRooms: string[] = [];
  leaveRooms: string[] = [];
  joinedRooms: string[] = [];
  eventsSince = new Map<string, PDU[]>();
  eventsById = new Map<string, PDU>();
  roomAccountData = new Map<string, any[]>();
  receiptsByRoom = new Map<string, { type: string; content: Record<string, unknown> }>();
  unreadSummaryByRoom = new Map<
    string,
    {
      room: { notification_count: number; highlight_count: number };
      main: { notification_count: number; highlight_count: number };
      threads: Record<string, { notification_count: number; highlight_count: number }>;
    }
  >();
  typingUsersByRoom = new Map<string, string[]>();
  globalAccountData: any[] = [];
  deviceListChanges = { changed: [] as string[], left: [] as string[] };

  async loadFilter() {
    return null;
  }
  async getLatestStreamPosition() {
    return 5;
  }
  async getLatestDeviceKeyPosition() {
    return 0;
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
    return this.deviceListChanges;
  }
  async getGlobalAccountData() {
    return this.globalAccountData;
  }
  async getRoomAccountData(_userId: string, roomId: string) {
    return this.roomAccountData.get(roomId) ?? [];
  }
  async getUserRooms(_userId?: string, membership?: "join" | "invite" | "leave" | "ban" | "knock") {
    if (membership === "join") return this.joinedRooms;
    if (membership === "invite") return this.inviteRooms;
    if (membership === "knock") return this.knockRooms;
    if (membership === "leave") return this.leaveRooms;
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
  async getReceiptsForRoom(roomId: string) {
    return this.receiptsByRoom.get(roomId) ?? { type: "m.receipt", content: {} };
  }
  async getUnreadNotificationSummary(roomId: string) {
    return (
      this.unreadSummaryByRoom.get(roomId) ?? {
        room: { notification_count: 0, highlight_count: 0 },
        main: { notification_count: 0, highlight_count: 0 },
        threads: {},
      }
    );
  }
  async getTypingUsers(roomId: string) {
    return this.typingUsersByRoom.get(roomId) ?? [];
  }
  async waitForUserEvents() {
    return { hasEvents: false };
  }
}

describe("sync-projection", () => {
  it("projects invite rooms with a current leave member event into leave rooms", async () => {
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

    const projection = await projectMembershipRooms(repo, {
      userId: "@alice:test",
      sincePosition: 1,
      includeLeave: true,
    });

    expect(projection.inviteRooms[roomId]).toBeUndefined();
    expect(projection.leaveRooms[roomId]?.timeline?.events[0]).toMatchObject({
      event_id: "$leave",
      content: { membership: "leave" },
    });
  });

  it("adds the knock membership event to knock_state when stripped state omits it", async () => {
    const repo = new FakeSyncRepository();
    const roomId = "!room:hs1";
    repo.knockRooms = [roomId];
    repo.memberships.set(`${roomId}:@alice:test`, { membership: "knock", eventId: "$knock" });
    repo.roomStates.set(roomId, []);
    repo.inviteStates.set(roomId, [
      {
        type: "m.room.name",
        state_key: "",
        content: { name: "Lobby" },
        sender: "@creator:hs1",
      },
    ]);
    repo.eventsById.set("$knock", {
      event_id: "$knock",
      room_id: roomId,
      sender: "@alice:test",
      type: "m.room.member",
      state_key: "@alice:test",
      content: { membership: "knock" },
      origin_server_ts: 20,
      depth: 2,
      auth_events: [],
      prev_events: [],
    });

    const projection = await projectMembershipRooms(repo, {
      userId: "@alice:test",
      sincePosition: 1,
      includeLeave: false,
    });

    expect(projection.knockRooms[roomId]?.knock_state?.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "m.room.name" }),
        expect.objectContaining({
          type: "m.room.member",
          state_key: "@alice:test",
          content: { membership: "knock" },
        }),
      ]),
    );
  });

  it("prefers incremental leave events when projecting leave rooms", async () => {
    const repo = new FakeSyncRepository();
    const roomId = "!room:hs1";
    const leaveEvent: PDU = {
      event_id: "$leave",
      room_id: roomId,
      sender: "@alice:test",
      type: "m.room.member",
      state_key: "@alice:test",
      content: { membership: "leave" },
      origin_server_ts: 30,
      depth: 2,
      auth_events: [],
      prev_events: ["$invite"],
    };
    repo.leaveRooms = [roomId];
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

    const projection = await projectMembershipRooms(repo, {
      userId: "@alice:test",
      sincePosition: 5,
      includeLeave: true,
    });

    expect(projection.leaveRooms[roomId]?.timeline?.events[0]).toMatchObject({
      event_id: "$leave",
      content: { membership: "leave" },
    });
  });

  it("projects banned rooms through leave rooms with the ban membership event", async () => {
    const repo = new FakeSyncRepository();
    const roomId = "!room:hs1";
    const banEvent: PDU = {
      event_id: "$ban",
      room_id: roomId,
      sender: "@bob:hs1",
      type: "m.room.member",
      state_key: "@alice:test",
      content: { membership: "ban" },
      origin_server_ts: 40,
      depth: 3,
      auth_events: [],
      prev_events: ["$join"],
    };
    repo.leaveRooms = [];
    repo.memberships.set(`${roomId}:@alice:test`, { membership: "ban", eventId: "$ban" });
    repo.eventsById.set("$ban", banEvent);
    repo.roomStates.set(roomId, [banEvent]);

    const projection = await projectMembershipRooms(repo, {
      userId: "@alice:test",
      sincePosition: 1,
      includeLeave: true,
    });

    expect(projection.leaveRooms[roomId]?.timeline?.events[0]).toMatchObject({
      event_id: "$ban",
      content: { membership: "ban" },
    });
  });

  it("suppresses invite rooms when invite permissions ignore the inviter", async () => {
    const repo = new FakeSyncRepository();
    const roomId = "!room:hs1";
    repo.inviteRooms = [roomId];
    repo.globalAccountData = [
      {
        type: "org.matrix.msc4155.invite_permission_config",
        content: {
          ignored_users: ["@bob:hs2"],
        },
      },
    ];
    repo.memberships.set(`${roomId}:@alice:hs1`, { membership: "invite", eventId: "$invite" });
    repo.eventsById.set("$invite", {
      event_id: "$invite",
      room_id: roomId,
      sender: "@bob:hs2",
      type: "m.room.member",
      state_key: "@alice:hs1",
      content: { membership: "invite" },
      origin_server_ts: 10,
      depth: 1,
      auth_events: [],
      prev_events: [],
    });
    repo.roomStates.set(roomId, [
      {
        event_id: "$invite",
        room_id: roomId,
        sender: "@bob:hs2",
        type: "m.room.member",
        state_key: "@alice:hs1",
        content: { membership: "invite" },
        origin_server_ts: 10,
        depth: 1,
        auth_events: [],
        prev_events: [],
      },
    ]);

    const projection = await projectMembershipRooms(repo, {
      userId: "@alice:hs1",
      sincePosition: 0,
      includeLeave: false,
    });

    expect(projection.inviteRooms[roomId]).toBeUndefined();
  });

  it("suppresses invite rooms when ignored users account data ignores the inviter", async () => {
    const repo = new FakeSyncRepository();
    const roomId = "!room:hs1";
    repo.inviteRooms = [roomId];
    repo.globalAccountData = [
      {
        type: "m.ignored_user_list",
        content: {
          ignored_users: {
            "@bob:hs2": {},
          },
        },
      },
    ];
    repo.memberships.set(`${roomId}:@alice:hs1`, { membership: "invite", eventId: "$invite" });
    repo.eventsById.set("$invite", {
      event_id: "$invite",
      room_id: roomId,
      sender: "@bob:hs2",
      type: "m.room.member",
      state_key: "@alice:hs1",
      content: { membership: "invite" },
      origin_server_ts: 10,
      depth: 1,
      auth_events: [],
      prev_events: [],
    });
    repo.roomStates.set(roomId, [
      {
        event_id: "$invite",
        room_id: roomId,
        sender: "@bob:hs2",
        type: "m.room.member",
        state_key: "@alice:hs1",
        content: { membership: "invite" },
        origin_server_ts: 10,
        depth: 1,
        auth_events: [],
        prev_events: [],
      },
    ]);

    const projection = await projectMembershipRooms(repo, {
      userId: "@alice:hs1",
      sincePosition: 0,
      includeLeave: false,
    });

    expect(projection.inviteRooms[roomId]).toBeUndefined();
  });

  it("adds the invite membership event to invite_state when stripped state omits it", async () => {
    const repo = new FakeSyncRepository();
    const roomId = "!room:hs1";
    repo.inviteRooms = [roomId];
    repo.memberships.set(`${roomId}:@alice:hs1`, { membership: "invite", eventId: "$invite" });
    repo.eventsById.set("$invite", {
      event_id: "$invite",
      room_id: roomId,
      sender: "@bob:hs2",
      type: "m.room.member",
      state_key: "@alice:hs1",
      content: { membership: "invite" },
      origin_server_ts: 10,
      depth: 1,
      auth_events: [],
      prev_events: [],
    });
    repo.inviteStates.set(roomId, [
      {
        type: "m.room.name",
        state_key: "",
        content: { name: "Lobby" },
        sender: "@bob:hs2",
      },
    ]);

    const projection = await projectMembershipRooms(repo, {
      userId: "@alice:hs1",
      sincePosition: 0,
      includeLeave: false,
    });

    expect(projection.inviteRooms[roomId]?.invite_state?.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "m.room.name" }),
        expect.objectContaining({
          type: "m.room.member",
          state_key: "@alice:hs1",
          content: { membership: "invite" },
        }),
      ]),
    );
  });

  it("projects joined room timeline, state, account data, and ephemeral events separately", async () => {
    const repo = new FakeSyncRepository();
    const roomId = "!room:hs1";
    repo.joinedRooms = [roomId];
    repo.eventsSince.set(roomId, [
      {
        event_id: "$message",
        room_id: roomId,
        sender: "@bob:hs1",
        type: "m.room.message",
        content: { body: "hello", msgtype: "m.text" },
        origin_server_ts: 20,
        depth: 2,
        auth_events: [],
        prev_events: [],
      },
      {
        event_id: "$topic",
        room_id: roomId,
        sender: "@bob:hs1",
        type: "m.room.topic",
        state_key: "",
        content: { topic: "General" },
        origin_server_ts: 30,
        depth: 3,
        auth_events: [],
        prev_events: ["$message"],
      },
    ]);
    repo.roomStates.set(roomId, [
      {
        event_id: "$create",
        room_id: roomId,
        sender: "@alice:test",
        type: "m.room.create",
        state_key: "",
        content: { creator: "@alice:test" },
        origin_server_ts: 10,
        depth: 1,
        auth_events: [],
        prev_events: [],
      },
      {
        event_id: "$topic",
        room_id: roomId,
        sender: "@bob:hs1",
        type: "m.room.topic",
        state_key: "",
        content: { topic: "General" },
        origin_server_ts: 30,
        depth: 3,
        auth_events: [],
        prev_events: ["$message"],
      },
    ]);
    repo.roomAccountData.set(roomId, [{ type: "m.tag", content: { tags: {} } }]);
    repo.receiptsByRoom.set(roomId, {
      type: "m.receipt",
      content: { $message: { "m.read": { "@alice:test": { ts: 100 } } } },
    });
    repo.typingUsersByRoom.set(roomId, ["@bob:hs1"]);
    repo.unreadSummaryByRoom.set(roomId, {
      room: { notification_count: 3, highlight_count: 1 },
      main: { notification_count: 2, highlight_count: 1 },
      threads: { $root: { notification_count: 1, highlight_count: 0 } },
    });

    const projection = await projectJoinedRoom(repo, {
      userId: "@alice:test",
      roomId,
      sincePosition: 5,
      fullState: true,
      roomFilter: {
        timeline: { types: ["m.room.*"] },
        state: { types: ["m.room.*"] },
        ephemeral: { types: ["m.typing"] },
      },
    });

    expect(projection.timeline?.events).toEqual([
      expect.objectContaining({ event_id: "$message", type: "m.room.message" }),
      expect.objectContaining({ event_id: "$topic", type: "m.room.topic" }),
    ]);
    expect(projection.state?.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event_id: "$create", type: "m.room.create" }),
        expect.objectContaining({ event_id: "$topic", type: "m.room.topic" }),
      ]),
    );
    expect(projection.account_data?.events).toEqual([{ type: "m.tag", content: { tags: {} } }]);
    expect(projection.ephemeral?.events).toEqual([
      { type: "m.typing", content: { user_ids: ["@bob:hs1"] } },
    ]);
    expect(projection.unread_notifications).toEqual({
      notification_count: 3,
      highlight_count: 1,
    });
    expect(projection.unread_thread_notifications).toBeUndefined();
  });

  it("projects threaded unread notifications separately when requested by the sync filter", async () => {
    const repo = new FakeSyncRepository();
    const roomId = "!room:hs1";
    repo.unreadSummaryByRoom.set(roomId, {
      room: { notification_count: 4, highlight_count: 2 },
      main: { notification_count: 2, highlight_count: 1 },
      threads: {
        $root: { notification_count: 2, highlight_count: 1 },
      },
    });

    const projection = await projectJoinedRoom(repo, {
      userId: "@alice:test",
      roomId,
      sincePosition: 5,
      roomFilter: {
        timeline: { unread_thread_notifications: true },
      },
    });

    expect(projection.unread_notifications).toEqual({
      notification_count: 2,
      highlight_count: 1,
    });
    expect(projection.unread_thread_notifications).toEqual({
      $root: { notification_count: 2, highlight_count: 1 },
    });
  });

  it("omits incremental state changes when the corresponding timeline event is filtered out", async () => {
    const repo = new FakeSyncRepository();
    const roomId = "!room:hs1";
    repo.eventsSince.set(roomId, [
      {
        event_id: "$topic",
        room_id: roomId,
        sender: "@bob:hs1",
        type: "m.room.topic",
        state_key: "",
        content: { topic: "Filtered" },
        origin_server_ts: 30,
        depth: 3,
        auth_events: [],
        prev_events: [],
      },
    ]);

    const projection = await projectJoinedRoom(repo, {
      userId: "@alice:test",
      roomId,
      sincePosition: 5,
      roomFilter: {
        timeline: { not_types: ["m.room.topic"] },
        state: { types: ["m.room.*"] },
      },
    });

    expect(projection.timeline?.events).toEqual([]);
    expect(projection.state?.events).toEqual([]);
  });

  it("includes an empty typing event on incremental syncs so typing stops are observable", async () => {
    const repo = new FakeSyncRepository();
    const roomId = "!room:hs1";

    const projection = await projectJoinedRoom(repo, {
      userId: "@alice:test",
      roomId,
      sincePosition: 5,
      roomFilter: {
        ephemeral: { types: ["m.typing"] },
      },
    });

    expect(projection.ephemeral?.events).toEqual([{ type: "m.typing", content: { user_ids: [] } }]);
  });

  it("adds sender membership state for lazy-loaded incremental syncs", async () => {
    const repo = new FakeSyncRepository();
    const roomId = "!room:hs1";
    repo.eventsSince.set(roomId, [
      {
        event_id: "$message",
        room_id: roomId,
        sender: "@derek:remote",
        type: "m.room.message",
        content: { body: "hello", msgtype: "m.text" },
        origin_server_ts: 20,
        depth: 2,
        auth_events: [],
        prev_events: [],
      },
    ]);
    repo.roomStates.set(roomId, [
      {
        event_id: "$member",
        room_id: roomId,
        sender: "@derek:remote",
        type: "m.room.member",
        state_key: "@derek:remote",
        content: { membership: "join" },
        origin_server_ts: 10,
        depth: 1,
        auth_events: [],
        prev_events: [],
      },
    ]);

    const projection = await projectJoinedRoom(repo, {
      userId: "@alice:test",
      roomId,
      sincePosition: 5,
      roomFilter: {
        timeline: { lazy_load_members: true },
        state: { lazy_load_members: true },
      },
    });

    expect(projection.timeline?.events).toEqual([
      expect.objectContaining({ event_id: "$message", sender: "@derek:remote" }),
    ]);
    expect(projection.state?.events).toEqual([
      expect.objectContaining({
        event_id: "$member",
        type: "m.room.member",
        state_key: "@derek:remote",
      }),
    ]);
  });

  it("projects global account data with filters applied", async () => {
    const repo = new FakeSyncRepository();
    repo.globalAccountData = [
      { type: "m.push_rules", content: {} },
      { type: "m.ignored_user_list", content: {} },
    ];

    const projection = await projectGlobalAccountData(repo, "@alice:test", 0, {
      types: ["m.push_rules"],
    });

    expect(projection).toEqual([{ type: "m.push_rules", content: {} }]);
  });

  it("bootstraps device_lists on initial sync and omits empty incremental changes", async () => {
    const repo = new FakeSyncRepository();

    await expect(
      projectDeviceLists(repo, {
        userId: "@alice:test",
        isInitialSync: true,
        sinceEventPosition: 0,
        sinceDeviceKeyPosition: 0,
      }),
    ).resolves.toEqual({ changed: ["@alice:test"], left: [] });

    repo.deviceListChanges = { changed: [], left: [] };
    await expect(
      projectDeviceLists(repo, {
        userId: "@alice:test",
        isInitialSync: false,
        sinceEventPosition: 5,
        sinceDeviceKeyPosition: 5,
      }),
    ).resolves.toBeUndefined();

    repo.deviceListChanges = { changed: ["@bob:hs1"], left: ["@carol:hs1"] };
    await expect(
      projectDeviceLists(repo, {
        userId: "@alice:test",
        isInitialSync: false,
        sinceEventPosition: 5,
        sinceDeviceKeyPosition: 5,
      }),
    ).resolves.toEqual({ changed: ["@bob:hs1"], left: ["@carol:hs1"] });

    repo.deviceListChanges = { changed: [], left: [] };
    await expect(
      projectDeviceLists(repo, {
        userId: "@alice:test",
        isInitialSync: false,
        sinceEventPosition: 0,
        sinceDeviceKeyPosition: 0,
      }),
    ).resolves.toBeUndefined();
  });
});
