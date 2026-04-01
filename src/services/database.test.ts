import { describe, expect, it } from "vitest";

import { deleteAllUserDevices, deleteDevice, getEvent, getRoomState, storeEvent } from "./database";

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
      all: async <T>() => ({ results: (handler?.all ?? []) as T[] }),
      first: async <T>() => (handler?.first ?? null) as T | null,
      run: async () => ({ success: true }),
    };

    return {
      bind: () => bound,
      all: bound.all,
      first: bound.first,
      run: bound.run,
    };
  }
}

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

  it("indexes m.thread relations when storing events", async () => {
    const queries: string[] = [];
    const boundParams: unknown[][] = [];
    const db = {
      prepare(query: string) {
        queries.push(query);

        if (/SELECT MAX\(stream_ordering\) as max_ordering FROM events/.test(query)) {
          return {
            bind: (...params: unknown[]) => {
              boundParams.push(params);
              return {
                first: async () => ({ max_ordering: 41 }),
                run: async () => ({ success: true }),
                all: async () => ({ results: [] }),
              };
            },
            first: async () => ({ max_ordering: 41 }),
            run: async () => ({ success: true }),
            all: async () => ({ results: [] }),
          };
        }

        return {
          bind: (...params: unknown[]) => {
            boundParams.push(params);

            if (/SELECT stream_ordering FROM events WHERE event_id = \?/.test(query)) {
              return {
                first: async () => null,
                run: async () => ({ success: true }),
                all: async () => ({ results: [] }),
              };
            }

            return {
              first: async () => null,
              run: async () => ({ success: true }),
              all: async () => ({ results: [] }),
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

    expect(queries.some((query) => /INSERT OR REPLACE INTO event_relations/.test(query))).toBe(
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
            if (/SELECT MAX\(pos\) as next_pos/.test(query)) {
              return {
                first: async () => ({ next_pos: 10 }),
                run: async () => ({ success: true }),
                all: async () => ({ results: [] }),
              };
            }
            return {
              first: async () => null,
              run: async () => ({ success: true }),
              all: async () => ({ results: [] }),
            };
          },
          first: async () => null,
          run: async () => ({ success: true }),
          all: async () => ({ results: [] }),
        };
      },
    } as unknown as D1Database;

    await deleteDevice(db, "@alice:test", "DEVICE123");

    expect(queries.some((query) => /INSERT INTO account_data/.test(query))).toBe(true);
    expect(boundParams).toContainEqual([
      "@alice:test",
      "org.matrix.msc3890.local_notification_settings.DEVICE123",
    ]);
    expect(queries.some((query) => /INSERT INTO account_data_changes/.test(query))).toBe(true);
    expect(queries.some((query) => /DELETE FROM devices/.test(query))).toBe(true);
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
                all: async () => ({
                  results: [
                    {
                      event_type: "org.matrix.msc3890.local_notification_settings.A",
                    },
                    {
                      event_type: "org.matrix.msc3890.local_notification_settings.B",
                    },
                  ],
                }),
                first: async () => null,
                run: async () => ({ success: true }),
              };
            }
            if (/SELECT MAX\(pos\) as next_pos/.test(query)) {
              return {
                first: async () => ({ next_pos: 10 }),
                run: async () => ({ success: true }),
                all: async () => ({ results: [] }),
              };
            }
            return {
              all: async () => ({ results: [] }),
              first: async () => null,
              run: async () => ({ success: true }),
            };
          },
          all: async () => ({ results: [] }),
          first: async () => null,
          run: async () => ({ success: true }),
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
    expect(queries.some((query) => /DELETE FROM devices WHERE user_id = \?/.test(query))).toBe(
      true,
    );
  });
});
