import { describe, expect, it } from "vitest";

import { countUnreadNotificationSummaryWithRules } from "./push-rule-evaluator";

class MockD1Database {
  prepare(query: string) {
    return {
      bind: (...params: unknown[]) => ({
        all: <T>() => {
          if (/FROM push_rules/.test(query)) {
            return { results: [] as T[] };
          }

          if (/FROM events e\s+LEFT JOIN event_relations/.test(query)) {
            return {
              results: [
                {
                  event_id: "$A",
                  event_type: "m.room.message",
                  content: JSON.stringify({ body: "hello", msgtype: "m.text" }),
                  sender: "@alice:test",
                  room_id: "!room:test",
                  state_key: null,
                  stream_ordering: 1,
                  thread_root: null,
                },
                {
                  event_id: "$B",
                  event_type: "m.room.message",
                  content: JSON.stringify({ body: "thread one", msgtype: "m.text" }),
                  sender: "@alice:test",
                  room_id: "!room:test",
                  state_key: null,
                  stream_ordering: 2,
                  thread_root: "$A",
                },
                {
                  event_id: "$C",
                  event_type: "m.room.message",
                  content: JSON.stringify({ body: "hi Bob", msgtype: "m.text" }),
                  sender: "@alice:test",
                  room_id: "!room:test",
                  state_key: null,
                  stream_ordering: 3,
                  thread_root: "$A",
                },
                {
                  event_id: "$D",
                  event_type: "m.room.message",
                  content: JSON.stringify({ body: "ping Bob", msgtype: "m.text" }),
                  sender: "@alice:test",
                  room_id: "!room:test",
                  state_key: null,
                  stream_ordering: 4,
                  thread_root: null,
                },
                {
                  event_id: "$E",
                  event_type: "m.room.message",
                  content: JSON.stringify({ body: "thread two", msgtype: "m.text" }),
                  sender: "@alice:test",
                  room_id: "!room:test",
                  state_key: null,
                  stream_ordering: 5,
                  thread_root: "$A",
                },
                {
                  event_id: "$F",
                  event_type: "m.room.message",
                  content: JSON.stringify({ body: "reference", msgtype: "m.text" }),
                  sender: "@alice:test",
                  room_id: "!room:test",
                  state_key: null,
                  stream_ordering: 6,
                  thread_root: null,
                },
              ] as T[],
            };
          }

          return { results: [] as T[] };
        },
        first: <T>() => {
          if (/event_type = 'm\.fully_read'/.test(query)) {
            return null as T | null;
          }

          if (/SELECT stream_ordering FROM events WHERE event_id = \?/.test(query)) {
            const [eventId] = params;
            const positions: Record<string, number> = {
              $A: 1,
              $B: 2,
              $D: 4,
              $G: 7,
            };
            return (
              eventId && typeof eventId === "string" && positions[eventId] !== undefined
                ? ({ stream_ordering: positions[eventId] } as T)
                : null
            ) as T | null;
          }

          if (/COUNT\(\*\) as count FROM room_memberships/.test(query)) {
            return { count: 2 } as T;
          }

          if (/SELECT display_name FROM users WHERE user_id = \?/.test(query)) {
            return { display_name: "Bob" } as T;
          }

          return null as T | null;
        },
        run: () => ({ success: true }),
      }),
    };
  }
}

describe("push-rule-evaluator unread thread counts", () => {
  it("splits main and thread unread counts using unthreaded and threaded receipts", async () => {
    const db = new MockD1Database() as unknown as D1Database;

    const summary = await countUnreadNotificationSummaryWithRules(db, "@bob:test", "!room:test", {
      $A: { "m.read": { "@bob:test": { ts: 1, thread_id: "main" } } },
      $B: { "m.read": { "@bob:test": { ts: 2, thread_id: "$A" } } },
      $D: { "m.read": { "@bob:test": { ts: 3 } } },
    });

    expect(summary.room).toEqual({ notification_count: 2, highlight_count: 0 });
    expect(summary.main).toEqual({ notification_count: 1, highlight_count: 0 });
    expect(summary.threads).toEqual({
      $A: { notification_count: 1, highlight_count: 0 },
    });
  });
});
