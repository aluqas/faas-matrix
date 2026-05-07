import { describe, expect, it } from "vitest";

import {
  createDevice,
  deleteAllUserDevices,
  deleteDevice,
  getAuthChain,
  getEvent,
  getEventsSince,
  getLatestForwardExtremities,
  getRoomState,
  storeEvent,
} from "./database";

class MockD1Database {
  constructor(
    private readonly handlers: Array<{
      match: RegExp;
      all?: Array<Record<string, unknown>>;
      first?: Record<string, unknown> | null;
    }>,
  ) {}

  prepare(query: string) {
    const handler = this.handlers.find(({ match }) => match.test(query));
    const bound = {
      all: <T>() => ({ results: (handler?.all ?? []) as T[] }),
      first: <T>() => (handler?.first ?? null) as T | null,
      run: () => ({ success: true }),
    };

    return {
      bind: () => bound,
      all: bound.all,
      first: bound.first,
      run: bound.run,
    };
  }
}

describe("createDevice", () => {
  it("inserts a new device using ON CONFLICT upsert SQL", async () => {
    const queries: string[] = [];
    const boundParams: unknown[][] = [];
    const db = {
      prepare(query: string) {
        queries.push(query);
        return {
          bind: (...params: unknown[]) => {
            boundParams.push(params);
            return { run: () => ({ success: true }) };
          },
        };
      },
    } as unknown as D1Database;

    await createDevice(db, "@alice:test", "DEVICE1", "Alice's phone");

    expect(queries.some((q) => /ON CONFLICT/i.test(q))).toBe(true);
    expect(queries.some((q) => /DO UPDATE SET/i.test(q))).toBe(true);
    expect(boundParams.flat()).toContain("@alice:test");
    expect(boundParams.flat()).toContain("DEVICE1");
    expect(boundParams.flat()).toContain("Alice's phone");
  });

  it("does not overwrite an existing display_name when none is provided", async () => {
    const queries: string[] = [];
    const db = {
      prepare(query: string) {
        queries.push(query);
        return {
          bind: () => ({ run: () => ({ success: true }) }),
        };
      },
    } as unknown as D1Database;

    await createDevice(db, "@alice:test", "DEVICE1");

    const upsertSql = queries.find((q) => /ON CONFLICT/i.test(q)) ?? "";
    expect(upsertSql).toContain("ELSE devices.display_name END");
  });
});

describe("database state helpers", () => {
  it("adds m.room.create to room state when it only exists in events", async () => {
    const db = new MockD1Database([
      {
        match: /FROM room_state rs/,
        all: [
          {
            event_id: "$name",
            room_id: "!room:test",
            sender: "@alice:test",
            event_type: "m.room.name",
            state_key: "",
            content: JSON.stringify({ name: "Room" }),
            origin_server_ts: 1,
            unsigned: null,
            depth: 2,
            auth_events: JSON.stringify(["$create"]),
            prev_events: JSON.stringify(["$prev"]),
          },
        ],
      },
      {
        match: /event_type = 'm\.room\.create'/,
        first: {
          event_id: "$create",
          room_id: "!room:test",
          sender: "@alice:test",
          event_type: "m.room.create",
          state_key: "",
          content: JSON.stringify({ creator: "@alice:test", room_version: "10" }),
          origin_server_ts: 0,
          unsigned: null,
          depth: 1,
          auth_events: JSON.stringify([]),
          prev_events: JSON.stringify([]),
        },
      },
    ]);

    const state = await getRoomState(db as unknown as D1Database, "!room:test");

    expect(state.map((event) => event.type)).toContain("m.room.create");
  });

  it("falls back safely when stored event JSON is malformed", async () => {
    const db = new MockD1Database([
      {
        match: /FROM events WHERE event_id = \?/,
        first: {
          event_id: "$bad",
          room_id: "!room:test",
          sender: "@alice:test",
          event_type: "m.room.message",
          state_key: null,
          content: "{invalid",
          origin_server_ts: 2,
          unsigned: "{invalid",
          depth: 3,
          auth_events: "{invalid",
          prev_events: "{invalid",
          hashes: "{invalid",
          signatures: "{invalid",
        },
      },
    ]);

    const event = await getEvent(db as unknown as D1Database, "$bad");

    expect(event).not.toBeNull();
    expect(event?.content).toEqual({});
    expect(event?.auth_events).toEqual([]);
    expect(event?.prev_events).toEqual([]);
    expect(event?.hashes).toEqual({ sha256: "" });
    expect(event?.signatures).toEqual({});
  });

  it("preserves stored federation-only top-level fields on event lookup", async () => {
    const db = new MockD1Database([
      {
        match: /FROM events WHERE event_id = \?/,
        first: {
          event_id: "$member",
          room_id: "!room:test",
          sender: "@alice:remote.test",
          event_type: "m.room.member",
          state_key: "@alice:remote.test",
          content: JSON.stringify({ membership: "join" }),
          origin_server_ts: 2,
          unsigned: null,
          depth: 3,
          auth_events: JSON.stringify(["$create"]),
          prev_events: JSON.stringify(["$prev"]),
          event_origin: "remote.test",
          event_membership: "join",
          prev_state: JSON.stringify(["$older"]),
          hashes: null,
          signatures: null,
        },
      },
    ]);

    const event = await getEvent(db as unknown as D1Database, "$member");

    expect(event).not.toBeNull();
    expect(event?.origin).toBe("remote.test");
    expect(event?.membership).toBe("join");
    expect(event?.prev_state).toEqual(["$older"]);
  });

  it("loads auth chains recursively", async () => {
    const db = new MockD1Database([
      {
        match: /FROM events WHERE event_id IN/,
        all: [
          {
            event_id: "$a",
            room_id: "!room:test",
            sender: "@alice:test",
            event_type: "m.room.member",
            state_key: "@alice:test",
            content: JSON.stringify({ membership: "join" }),
            origin_server_ts: 3,
            unsigned: null,
            depth: 3,
            auth_events: JSON.stringify(["$b"]),
            prev_events: JSON.stringify([]),
          },
          {
            event_id: "$b",
            room_id: "!room:test",
            sender: "@alice:test",
            event_type: "m.room.power_levels",
            state_key: "",
            content: JSON.stringify({ users_default: 0 }),
            origin_server_ts: 2,
            unsigned: null,
            depth: 2,
            auth_events: JSON.stringify(["$c"]),
            prev_events: JSON.stringify([]),
          },
          {
            event_id: "$c",
            room_id: "!room:test",
            sender: "@alice:test",
            event_type: "m.room.create",
            state_key: "",
            content: JSON.stringify({ creator: "@alice:test", room_version: "10" }),
            origin_server_ts: 1,
            unsigned: null,
            depth: 1,
            auth_events: JSON.stringify([]),
            prev_events: JSON.stringify([]),
          },
        ],
      },
    ]);

    const authChain = await getAuthChain(db as unknown as D1Database, ["$a"]);

    expect(new Set(authChain.map((event) => event.event_id))).toEqual(new Set(["$a", "$b", "$c"]));
  });

  it("returns the latest events first for initial sync windows", async () => {
    const db = new MockD1Database([
      {
        match: /ORDER BY stream_ordering DESC/,
        all: [
          {
            event_id: "$latest",
            room_id: "!room:test",
            sender: "@alice:test",
            event_type: "m.room.message",
            state_key: null,
            content: JSON.stringify({ body: "latest", msgtype: "m.text" }),
            origin_server_ts: 3,
            unsigned: null,
            depth: 3,
            auth_events: JSON.stringify([]),
            prev_events: JSON.stringify(["$middle"]),
          },
          {
            event_id: "$middle",
            room_id: "!room:test",
            sender: "@alice:test",
            event_type: "m.room.message",
            state_key: null,
            content: JSON.stringify({ body: "middle", msgtype: "m.text" }),
            origin_server_ts: 2,
            unsigned: null,
            depth: 2,
            auth_events: JSON.stringify([]),
            prev_events: JSON.stringify(["$oldest"]),
          },
        ],
      },
    ]);

    const events = await getEventsSince(db as unknown as D1Database, "!room:test", 0, 2);

    expect(events.map((event) => event.event_id)).toEqual(["$middle", "$latest"]);
  });

  it("returns forward extremities instead of intermediate events", async () => {
    const db = new MockD1Database([
      {
        match: /json_each\(child\.prev_events\)/,
        all: [
          {
            event_id: "$join",
            room_id: "!room:test",
            sender: "@alice:test",
            event_type: "m.room.member",
            state_key: "@alice:test",
            content: JSON.stringify({ membership: "join" }),
            origin_server_ts: 3,
            unsigned: null,
            depth: 3,
            auth_events: JSON.stringify(["$pl"]),
            prev_events: JSON.stringify(["$pl"]),
          },
        ],
      },
    ]);

    const events = await getLatestForwardExtremities(db as unknown as D1Database, "!room:test", 1);

    expect(events.map((event) => event.event_id)).toEqual(["$join"]);
  });

  it("indexes m.thread relations when storing events", async () => {
    const queries: string[] = [];
    const boundParams: unknown[][] = [];
    const db = {
      prepare(query: string) {
        queries.push(query);

        if (query.includes("SELECT MAX(stream_ordering) as max_ordering FROM events")) {
          return {
            bind: (...params: unknown[]) => {
              boundParams.push(params);
              return {
                first: () => ({ max_ordering: 41 }),
                run: () => ({ success: true }),
                all: () => ({ results: [] }),
              };
            },
            first: () => ({ max_ordering: 41 }),
            run: () => ({ success: true }),
            all: () => ({ results: [] }),
          };
        }

        return {
          bind: (...params: unknown[]) => {
            boundParams.push(params);

            if (query.includes("SELECT stream_ordering FROM events WHERE event_id = ?")) {
              return {
                first: () => null,
                run: () => ({ success: true }),
                all: () => ({ results: [] }),
              };
            }

            return {
              first: () => null,
              run: () => ({ success: true }),
              all: () => ({ results: [] }),
            };
          },
        };
      },
    } as unknown as D1Database;

    await storeEvent(db, {
      event_id: "$reply",
      room_id: "!room:test",
      sender: "@alice:test",
      type: "m.room.message",
      content: {
        body: "reply",
        msgtype: "m.text",
        "m.relates_to": {
          rel_type: "m.thread",
          event_id: "$root",
        },
      },
      origin_server_ts: 1,
      depth: 1,
      auth_events: [],
      prev_events: [],
    });

    expect(queries.some((query) => query.includes("INSERT OR REPLACE INTO event_relations"))).toBe(
      true,
    );
    expect(boundParams).toContainEqual(["$reply", "$root", "m.thread", null]);
  });

  it("tombstones device local notification settings when deleting a device", async () => {
    const queries: string[] = [];
    const boundParams: unknown[][] = [];
    const db = {
      prepare(query: string) {
        queries.push(query);
        return {
          bind: (...params: unknown[]) => {
            boundParams.push(params);
            if (query.includes("SELECT MAX(pos) as next_pos")) {
              return {
                first: () => ({ next_pos: 10 }),
                run: () => ({ success: true }),
                all: () => ({ results: [] }),
              };
            }
            return {
              first: () => null,
              run: () => ({ success: true }),
              all: () => ({ results: [] }),
            };
          },
          first: () => null,
          run: () => ({ success: true }),
          all: () => ({ results: [] }),
        };
      },
    } as unknown as D1Database;

    await deleteDevice(db, "@alice:test", "DEVICE123");

    expect(queries.some((query) => query.includes("INSERT INTO account_data"))).toBe(true);
    expect(boundParams).toContainEqual([
      "@alice:test",
      "org.matrix.msc3890.local_notification_settings.DEVICE123",
    ]);
    expect(queries.some((query) => query.includes("INSERT INTO account_data_changes"))).toBe(true);
    expect(queries.some((query) => query.includes("DELETE FROM devices"))).toBe(true);
  });

  it("tombstones all device local notification settings when deleting all devices", async () => {
    const queries: string[] = [];
    const boundParams: unknown[][] = [];
    const db = {
      prepare(query: string) {
        queries.push(query);
        return {
          bind: (...params: unknown[]) => {
            boundParams.push(params);
            if (/SELECT event_type\s+FROM account_data/.test(query)) {
              return {
                all: () => ({
                  results: [
                    {
                      event_type: "org.matrix.msc3890.local_notification_settings.A",
                    },
                    {
                      event_type: "org.matrix.msc3890.local_notification_settings.B",
                    },
                  ],
                }),
                first: () => null,
                run: () => ({ success: true }),
              };
            }
            if (query.includes("SELECT MAX(pos) as next_pos")) {
              return {
                first: () => ({ next_pos: 10 }),
                run: () => ({ success: true }),
                all: () => ({ results: [] }),
              };
            }
            return {
              all: () => ({ results: [] }),
              first: () => null,
              run: () => ({ success: true }),
            };
          },
          all: () => ({ results: [] }),
          first: () => null,
          run: () => ({ success: true }),
        };
      },
    } as unknown as D1Database;

    await deleteAllUserDevices(db, "@alice:test");

    expect(boundParams).toContainEqual([
      "@alice:test",
      "org.matrix.msc3890.local_notification_settings.%",
    ]);
    expect(boundParams).toContainEqual([
      "@alice:test",
      "org.matrix.msc3890.local_notification_settings.A",
    ]);
    expect(boundParams).toContainEqual([
      "@alice:test",
      "org.matrix.msc3890.local_notification_settings.B",
    ]);
    expect(queries.some((query) => query.includes("DELETE FROM devices WHERE user_id = ?"))).toBe(
      true,
    );
  });
});
