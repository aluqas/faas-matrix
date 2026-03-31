import { describe, expect, it } from "vitest";

import { getRoomState } from "./database";

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
});
