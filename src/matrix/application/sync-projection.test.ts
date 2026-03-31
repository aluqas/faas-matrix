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
    { membership: "invite" | "join" | "leave" | "knock"; eventId: string }
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
  typingUsersByRoom = new Map<string, string[]>();
  globalAccountData: any[] = [];
  deviceListChanges = { changed: [] as string[], left: [] as string[] };

  async loadFilter() {
    return null;
  }
  async getLatestStreamPosition() {
    return 5;
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
        sincePosition: 0,
      }),
    ).resolves.toEqual({ changed: ["@alice:test"], left: [] });

    repo.deviceListChanges = { changed: [], left: [] };
    await expect(
      projectDeviceLists(repo, {
        userId: "@alice:test",
        sincePosition: 5,
      }),
    ).resolves.toBeUndefined();

    repo.deviceListChanges = { changed: ["@bob:hs1"], left: ["@carol:hs1"] };
    await expect(
      projectDeviceLists(repo, {
        userId: "@alice:test",
        sincePosition: 5,
      }),
    ).resolves.toEqual({ changed: ["@bob:hs1"], left: ["@carol:hs1"] });
  });
});
