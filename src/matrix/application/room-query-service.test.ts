import { describe, expect, it } from "vitest";
import type { AppContext } from "../../foundation/app-context";
import { createFeatureProfile } from "../../foundation/config/feature-profile";
import type { PDU } from "../../types";
import { runClientEffect } from "./effect-runtime";
import {
  MatrixRoomQueryService,
  type RoomMessagesRelationFilter,
  type RoomQueryDependencies,
} from "./room-query-service";

function createTestAppContext(now = 1_700_000_000_000) {
  return {
    profile: createFeatureProfile("full"),
    capabilities: {
      sql: { connection: {} },
      kv: {},
      blob: {},
      jobs: { defer: (_task: Promise<unknown>) => undefined },
      workflow: {
        async createRoomJoin() {
          return { status: "complete", output: { success: true } };
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
      clock: { now: () => now },
      id: {
        async generateRoomId(serverName: string) {
          return `!room:${serverName}`;
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
        serverVersion: "0.1.0",
      },
    },
    services: {},
    defer(task: Promise<unknown>) {
      void task;
    },
  } satisfies AppContext;
}

function createDependencies(overrides: Partial<RoomQueryDependencies> = {}): RoomQueryDependencies {
  const defaultEvent: PDU = {
    event_id: "$event:test",
    room_id: "!room:test",
    sender: "@alice:test",
    type: "m.room.message",
    content: { body: "hello" },
    origin_server_ts: 123,
    depth: 1,
    auth_events: [],
    prev_events: [],
  };

  return {
    async getMembership() {
      return { membership: "join", eventId: "$member:test" };
    },
    async getRoomState() {
      return [defaultEvent];
    },
    async getStateEvent(_db, roomId, eventType, stateKey) {
      return {
        ...defaultEvent,
        room_id: roomId,
        type: eventType,
        state_key: stateKey,
        content: { membership: "join" },
      };
    },
    async getRoomMembers() {
      return [
        { userId: "@alice:test", membership: "join" },
        { userId: "@bob:test", membership: "join" },
      ];
    },
    async getRoomEvents(
      _db,
      roomId,
      _fromToken,
      _limit,
      _direction,
      _relationFilter?: RoomMessagesRelationFilter,
    ) {
      return {
        events: [{ ...defaultEvent, room_id: roomId }],
        end: 5,
      };
    },
    async getVisibleEventForUser() {
      return defaultEvent;
    },
    async findClosestEventByTimestamp() {
      return { event_id: "$event:test", origin_server_ts: 123 };
    },
    async getPartialStateJoin() {
      return null;
    },
    async getPartialStateJoinCompletion() {
      return null;
    },
    async sleep() {},
    ...overrides,
  };
}

describe("MatrixRoomQueryService", () => {
  it("returns current state for joined or left members", async () => {
    const appContext = createTestAppContext();
    const service = new MatrixRoomQueryService(
      appContext,
      createDependencies({
        async getMembership() {
          return { membership: "leave", eventId: "$leave:test" };
        },
        async getRoomState() {
          return [
            {
              event_id: "$name:test",
              room_id: "!room:test",
              sender: "@alice:test",
              type: "m.room.name",
              state_key: "",
              content: { name: "Test Room" },
              origin_server_ts: 100,
              depth: 1,
              auth_events: [],
              prev_events: [],
            },
          ];
        },
      }),
    );

    await expect(
      runClientEffect(service.getCurrentState({ userId: "@alice:test", roomId: "!room:test" })),
    ).resolves.toEqual([
      {
        type: "m.room.name",
        state_key: "",
        content: { name: "Test Room" },
        sender: "@alice:test",
        origin_server_ts: 100,
        event_id: "$name:test",
        room_id: "!room:test",
      },
    ]);
  });

  it("waits for partial-state completion before loading members", async () => {
    const sleeps: number[] = [];
    let markerReads = 0;
    const appContext = createTestAppContext();
    const service = new MatrixRoomQueryService(
      appContext,
      createDependencies({
        async getPartialStateJoin() {
          markerReads += 1;
          return markerReads === 1 ? ({ roomId: "!room:test" } as never) : null;
        },
        async sleep(ms) {
          sleeps.push(ms);
        },
      }),
    );

    await expect(
      runClientEffect(service.getMembers({ userId: "@alice:test", roomId: "!room:test" })),
    ).resolves.toMatchObject({
      chunk: [
        {
          type: "m.room.member",
          state_key: "@alice:test",
        },
        {
          type: "m.room.member",
          state_key: "@bob:test",
        },
      ],
    });
    expect(sleeps).toEqual([100]);
  });

  it("normalizes s-prefixed message tokens", async () => {
    const seenFromTokens: Array<number | undefined> = [];
    const service = new MatrixRoomQueryService(
      createTestAppContext(),
      createDependencies({
        async getRoomEvents(_db, roomId, fromToken) {
          seenFromTokens.push(fromToken);
          return {
            events: [
              {
                event_id: "$msg:test",
                room_id: roomId,
                sender: "@alice:test",
                type: "m.room.message",
                content: { body: "hello" },
                origin_server_ts: 100,
                depth: 2,
                auth_events: [],
                prev_events: [],
              },
            ],
            end: 9,
          };
        },
      }),
    );

    await expect(
      runClientEffect(
        service.getMessages({
          userId: "@alice:test",
          roomId: "!room:test",
          from: "s3",
          dir: "b",
          limit: 20,
        }),
      ),
    ).resolves.toMatchObject({
      start: "s3",
      end: "s9",
      chunk: [{ event_id: "$msg:test" }],
    });
    expect(seenFromTokens).toEqual([3]);
  });

  it("maps invisible events to M_NOT_FOUND", async () => {
    const service = new MatrixRoomQueryService(
      createTestAppContext(),
      createDependencies({
        async getVisibleEventForUser() {
          return null;
        },
      }),
    );

    await expect(
      runClientEffect(
        service.getVisibleEvent({
          userId: "@alice:test",
          roomId: "!room:test",
          eventId: "$missing:test",
        }),
      ),
    ).rejects.toMatchObject({
      errcode: "M_NOT_FOUND",
      status: 404,
    });
  });
});
