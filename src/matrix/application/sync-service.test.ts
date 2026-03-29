import { describe, expect, it } from "vitest";
import type { AppContext } from "../../foundation/app-context";
import { MatrixSyncService } from "./sync-service";
import type { SyncRepository } from "../repositories/interfaces";
import type { PDU } from "../../types";

class FakeSyncRepository implements SyncRepository {
  waitCalls = 0;
  memberships = new Map<string, { membership: "invite" | "join" | "leave"; eventId: string }>();
  roomStates = new Map<string, PDU[]>();
  inviteStates = new Map<
    string,
    Array<{ type: string; state_key: string; content: any; sender: string }>
  >();
  inviteRooms: string[] = [];
  eventsSince = new Map<string, PDU[]>();
  eventsById = new Map<string, PDU>();

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
    return { changed: [], left: [] };
  }
  async getGlobalAccountData() {
    return [];
  }
  async getRoomAccountData() {
    return [];
  }
  async getUserRooms(_userId?: string, membership?: "join" | "invite" | "leave" | "ban" | "knock") {
    if (membership === "invite") return this.inviteRooms;
    if (membership === "leave") {
      return Array.from(this.memberships.entries())
        .filter(([, value]) => value.membership === "leave")
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
  async getTypingUsers() {
    return [];
  }
  async waitForUserEvents() {
    this.waitCalls += 1;
    return { hasEvents: false };
  }
}

describe("MatrixSyncService", () => {
  it("preserves composite sync tokens and waits when idle", async () => {
    const repo = new FakeSyncRepository();
    const service = new MatrixSyncService({} as AppContext, repo);

    const response = await service.syncUser({
      userId: "@alice:test",
      deviceId: null,
      since: "s2_td0",
      timeout: 2000,
    });

    expect(repo.waitCalls).toBe(1);
    expect(response.next_batch).toBe("s5_td0");
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

    const service = new MatrixSyncService({} as AppContext, repo);
    const response = await service.syncUser({
      userId: "@alice:test",
      deviceId: null,
      since: "s1_td0",
    });

    expect(response.rooms?.invite?.[roomId]).toBeUndefined();
    expect(response.rooms?.leave?.[roomId]?.timeline?.events[0]).toMatchObject({
      event_id: "$leave",
      state_key: "@alice:test",
      content: { membership: "leave" },
    });
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

    const service = new MatrixSyncService({} as AppContext, repo);
    const response = await service.syncUser({
      userId: "@alice:test",
      deviceId: null,
      since: "s1_td0",
    });

    expect(response.rooms?.leave?.[roomId]?.timeline?.events[0]).toMatchObject({
      event_id: "$leave",
      content: { membership: "leave" },
    });
  });
});
