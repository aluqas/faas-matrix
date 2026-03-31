import { describe, expect, it } from "vitest";
import { projectPresenceEvents } from "./project";

class FakePresenceDatabase {
  constructor(
    private readonly visibleUsers: string[],
    private readonly presenceRows: Array<{
      user_id: string;
      presence: string;
      status_msg: string | null;
      last_active_ts: number;
      currently_active?: number;
    }>,
  ) {}

  prepare(query: string) {
    let boundArgs: unknown[] = [];

    return {
      bind(...args: unknown[]) {
        boundArgs = args;
        return this;
      },
      all: async () => {
        if (query.includes("FROM room_state rs")) {
          return {
            results: this.visibleUsers.map((user_id) => ({ user_id })),
          };
        }

        if (query.includes("FROM presence")) {
          const requested = new Set(boundArgs as string[]);
          return {
            results: this.presenceRows.filter((row) => requested.has(row.user_id)),
          };
        }

        return { results: [] };
      },
    };
  }
}

describe("presence project", () => {
  it("projects top-level /sync presence events for visible joined users", async () => {
    const db = new FakePresenceDatabase(
      ["@bob:remote"],
      [
        {
          user_id: "@bob:remote",
          presence: "online",
          status_msg: "Available",
          last_active_ts: Date.now(),
          currently_active: 1,
        },
      ],
    );

    const projection = await projectPresenceEvents(db as unknown as D1Database, undefined, {
      userId: "@alice:test",
      roomIds: ["!room:hs1"],
    });

    expect(projection.events).toEqual([
      expect.objectContaining({
        type: "m.presence",
        sender: "@bob:remote",
        content: expect.objectContaining({
          presence: "online",
          status_msg: "Available",
        }),
      }),
    ]);
  });
});
