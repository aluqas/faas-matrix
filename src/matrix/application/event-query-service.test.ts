import { describe, expect, it } from "vitest";
import {
  EventQueryService,
  normalizeOffsetToken,
  selectSpaceChildren,
} from "./event-query-service";

class MockD1Database {
  constructor(
    private readonly handlers: Array<{
      match: RegExp;
      first?: Record<string, unknown> | null;
    }>,
  ) {}

  prepare(query: string) {
    const handler = this.handlers.find(({ match }) => match.test(query));
    const bound = {
      first: <T>() => (handler?.first ?? null) as T | null,
      run: () => ({ success: true }),
      all: <T>() => ({ results: [] as T[] }),
    };

    return {
      bind: () => bound,
      first: bound.first,
      run: bound.run,
      all: bound.all,
    };
  }
}

function createMissingEventsDb(options: {
  events: Map<string, Record<string, unknown>>;
  roomVersion?: string;
  historyRows?: Array<Record<string, unknown>>;
  membershipRows?: Array<Record<string, unknown>>;
  processedPdus?: Map<string, { accepted: number | boolean }>;
}): D1Database {
  const db = {
    prepare(query: string) {
      const normalizedQuery = query.replaceAll(/\s+/g, " ").trim();

      return {
        bind: (...args: unknown[]) => ({
          first: <T>() => {
            if (
              normalizedQuery.includes("SELECT accepted FROM processed_pdus WHERE event_id = ?")
            ) {
              const eventId = args[0] as string;
              return (options.processedPdus?.get(eventId) ?? null) as T | null;
            }

            if (normalizedQuery.includes("SELECT room_version FROM rooms WHERE room_id = ?")) {
              return { room_version: options.roomVersion ?? "10" } as T;
            }

            if (
              normalizedQuery.includes("FROM events WHERE event_id = ? AND room_id = ?") &&
              !normalizedQuery.includes("depth >= ?")
            ) {
              const eventId = args[0] as string;
              return (options.events.get(eventId) ?? null) as T | null;
            }

            if (
              normalizedQuery.includes(
                "FROM events WHERE event_id = ? AND room_id = ? AND depth >= ?",
              )
            ) {
              const eventId = args[0] as string;
              return (options.events.get(eventId) ?? null) as T | null;
            }

            return null as T | null;
          },
          all: <T>() => {
            if (
              normalizedQuery.includes(
                "FROM events WHERE room_id = ? AND event_type = 'm.room.history_visibility'",
              )
            ) {
              return { results: (options.historyRows ?? []) as T[] };
            }

            if (
              normalizedQuery.includes(
                "FROM events WHERE room_id = ? AND event_type = 'm.room.member' AND state_key LIKE ?",
              )
            ) {
              return { results: (options.membershipRows ?? []) as T[] };
            }

            if (
              normalizedQuery.includes(
                "FROM events WHERE room_id = ? AND event_type = 'm.room.member' AND state_key = ?",
              )
            ) {
              return { results: (options.membershipRows ?? []) as T[] };
            }

            return { results: [] as T[] };
          },
          run: () => ({ success: true }),
        }),
      };
    },
  };

  return db as unknown as D1Database;
}

describe("normalizeOffsetToken", () => {
  it("parses offset pagination tokens", () => {
    expect(normalizeOffsetToken("offset_12")).toBe(12);
    expect(normalizeOffsetToken("offset_-1")).toBe(0);
    expect(normalizeOffsetToken("bad")).toBe(0);
    expect(normalizeOffsetToken()).toBe(0);
  });
});

describe("selectSpaceChildren", () => {
  const children = [
    { roomId: "!a:test", content: { via: ["test"], suggested: true } },
    { roomId: "!b:test", content: { via: ["test"], suggested: false } },
    { roomId: "!c:test", content: { via: [], suggested: true } },
  ];

  it("filters deleted children and paginates", () => {
    const result = selectSpaceChildren(children, {
      suggestedOnly: false,
      limit: 1,
      offset: 0,
    });

    expect(result.children.map((child) => child.roomId)).toEqual(["!a:test"]);
    expect(result.hasMore).toBe(true);
  });

  it("honors suggested_only filtering", () => {
    const result = selectSpaceChildren(children, {
      suggestedOnly: true,
      limit: 10,
      offset: 0,
    });

    expect(result.children.map((child) => child.roomId)).toEqual(["!a:test"]);
    expect(result.hasMore).toBe(false);
  });
});

describe("EventQueryService.getMissingEvents", () => {
  it("returns missing events in ascending DAG order", async () => {
    const service = new EventQueryService();
    const events = new Map<string, Record<string, unknown>>([
      [
        "$latest",
        {
          event_id: "$latest",
          room_id: "!room:test",
          sender: "@bob:test",
          event_type: "m.room.message",
          state_key: null,
          content: JSON.stringify({ body: "latest" }),
          origin_server_ts: 4,
          depth: 4,
          auth_events: JSON.stringify([]),
          prev_events: JSON.stringify(["$mid"]),
          hashes: null,
          signatures: null,
        },
      ],
      [
        "$mid",
        {
          event_id: "$mid",
          room_id: "!room:test",
          sender: "@bob:test",
          event_type: "m.room.message",
          state_key: null,
          content: JSON.stringify({ body: "mid" }),
          origin_server_ts: 3,
          depth: 3,
          auth_events: JSON.stringify([]),
          prev_events: JSON.stringify(["$early"]),
          hashes: null,
          signatures: null,
        },
      ],
      [
        "$early",
        {
          event_id: "$early",
          room_id: "!room:test",
          sender: "@bob:test",
          event_type: "m.room.member",
          state_key: "@alice:test",
          content: JSON.stringify({ membership: "join" }),
          origin_server_ts: 2,
          depth: 2,
          auth_events: JSON.stringify([]),
          prev_events: JSON.stringify(["$start"]),
          hashes: null,
          signatures: null,
        },
      ],
      [
        "$start",
        {
          event_id: "$start",
          room_id: "!room:test",
          sender: "@alice:test",
          event_type: "m.room.create",
          state_key: "",
          content: JSON.stringify({ creator: "@alice:test" }),
          origin_server_ts: 1,
          depth: 1,
          auth_events: JSON.stringify([]),
          prev_events: JSON.stringify([]),
          hashes: null,
          signatures: null,
        },
      ],
    ]);
    const db = new MockD1Database([
      {
        match: /FROM events\s+WHERE event_id = \? AND room_id = \? AND depth >= \?/,
        first: null,
      },
    ]) as unknown as D1Database;

    db.prepare = (() => {
      const bound = {
        first: <T>(..._args: unknown[]) => null as T | null,
        run: () => ({ success: true }),
        all: <T>() => ({ results: [] as T[] }),
      };
      return {
        bind: (eventId: string) => ({
          ...bound,
          first: <T>() => (events.get(eventId) ?? null) as T | null,
        }),
        first: bound.first,
        run: bound.run,
        all: bound.all,
      };
    }) as unknown as typeof db.prepare;

    const result = await service.getMissingEvents(db, {
      roomId: "!room:test",
      earliestEvents: ["$start"],
      latestEvents: ["$latest"],
      limit: 10,
      minDepth: 0,
    });

    expect(result.map((event) => event.event_id)).toEqual(["$early", "$mid"]);
  });

  it("redacts non-state events that the requesting server could not see under joined visibility", async () => {
    const service = new EventQueryService();
    const db = createMissingEventsDb({
      roomVersion: "10",
      events: new Map<string, Record<string, unknown>>([
        [
          "$latest",
          {
            event_id: "$latest",
            room_id: "!room:test",
            sender: "@charlie:remote.test",
            event_type: "m.room.member",
            state_key: "@charlie:remote.test",
            content: JSON.stringify({ membership: "join" }),
            origin_server_ts: 3,
            depth: 3,
            auth_events: JSON.stringify([]),
            prev_events: JSON.stringify(["$message"]),
            hashes: null,
            signatures: null,
          },
        ],
        [
          "$message",
          {
            event_id: "$message",
            room_id: "!room:test",
            sender: "@alice:test",
            event_type: "m.room.message",
            state_key: null,
            content: JSON.stringify({ body: "secret", msgtype: "m.text" }),
            origin_server_ts: 2,
            depth: 2,
            auth_events: JSON.stringify([]),
            prev_events: JSON.stringify(["$start"]),
            hashes: null,
            signatures: null,
          },
        ],
        [
          "$start",
          {
            event_id: "$start",
            room_id: "!room:test",
            sender: "@alice:test",
            event_type: "m.room.create",
            state_key: "",
            content: JSON.stringify({ creator: "@alice:test" }),
            origin_server_ts: 1,
            depth: 1,
            auth_events: JSON.stringify([]),
            prev_events: JSON.stringify([]),
            hashes: null,
            signatures: null,
          },
        ],
      ]),
      historyRows: [
        {
          event_id: "$hist",
          origin_server_ts: 1,
          depth: 1,
          content: JSON.stringify({ history_visibility: "joined" }),
        },
      ],
      membershipRows: [
        {
          event_id: "$latest",
          origin_server_ts: 3,
          depth: 3,
          state_key: "@charlie:remote.test",
          content: JSON.stringify({ membership: "join" }),
        },
      ],
    });

    const result = await service.getMissingEvents(db, {
      roomId: "!room:test",
      earliestEvents: ["$start"],
      latestEvents: ["$latest"],
      limit: 10,
      minDepth: 0,
      requestingServer: "remote.test",
      roomVersion: "10",
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.type).toBe("m.room.message");
    expect(result[0]?.content).not.toHaveProperty("body");
    expect(result[0]?.content).not.toHaveProperty("msgtype");
  });

  it("keeps non-state events unredacted for shared visibility when the requesting server joined later", async () => {
    const service = new EventQueryService();
    const db = createMissingEventsDb({
      roomVersion: "10",
      events: new Map<string, Record<string, unknown>>([
        [
          "$latest",
          {
            event_id: "$latest",
            room_id: "!room:test",
            sender: "@charlie:remote.test",
            event_type: "m.room.member",
            state_key: "@charlie:remote.test",
            content: JSON.stringify({ membership: "join" }),
            origin_server_ts: 3,
            depth: 3,
            auth_events: JSON.stringify([]),
            prev_events: JSON.stringify(["$message"]),
            hashes: null,
            signatures: null,
          },
        ],
        [
          "$message",
          {
            event_id: "$message",
            room_id: "!room:test",
            sender: "@alice:test",
            event_type: "m.room.message",
            state_key: null,
            content: JSON.stringify({ body: "visible", msgtype: "m.text" }),
            origin_server_ts: 2,
            depth: 2,
            auth_events: JSON.stringify([]),
            prev_events: JSON.stringify(["$start"]),
            hashes: null,
            signatures: null,
          },
        ],
        [
          "$start",
          {
            event_id: "$start",
            room_id: "!room:test",
            sender: "@alice:test",
            event_type: "m.room.create",
            state_key: "",
            content: JSON.stringify({ creator: "@alice:test" }),
            origin_server_ts: 1,
            depth: 1,
            auth_events: JSON.stringify([]),
            prev_events: JSON.stringify([]),
            hashes: null,
            signatures: null,
          },
        ],
      ]),
      historyRows: [
        {
          event_id: "$hist",
          origin_server_ts: 1,
          depth: 1,
          content: JSON.stringify({ history_visibility: "shared" }),
        },
      ],
      membershipRows: [
        {
          event_id: "$latest",
          origin_server_ts: 3,
          depth: 3,
          state_key: "@charlie:remote.test",
          content: JSON.stringify({ membership: "join" }),
        },
      ],
    });

    const result = await service.getMissingEvents(db, {
      roomId: "!room:test",
      earliestEvents: ["$start"],
      latestEvents: ["$latest"],
      limit: 10,
      minDepth: 0,
      requestingServer: "remote.test",
      roomVersion: "10",
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.content).toMatchObject({ body: "visible", msgtype: "m.text" });
  });

  it("drops no-op history visibility events from missing-events responses", async () => {
    const service = new EventQueryService();
    const db = createMissingEventsDb({
      roomVersion: "10",
      events: new Map<string, Record<string, unknown>>([
        [
          "$latest",
          {
            event_id: "$latest",
            room_id: "!room:test",
            sender: "@charlie:remote.test",
            event_type: "m.room.member",
            state_key: "@charlie:remote.test",
            content: JSON.stringify({ membership: "join" }),
            origin_server_ts: 4,
            depth: 4,
            auth_events: JSON.stringify([]),
            prev_events: JSON.stringify(["$hist2"]),
            hashes: null,
            signatures: null,
          },
        ],
        [
          "$hist2",
          {
            event_id: "$hist2",
            room_id: "!room:test",
            sender: "@alice:test",
            event_type: "m.room.history_visibility",
            state_key: "",
            content: JSON.stringify({ history_visibility: "shared" }),
            origin_server_ts: 3,
            depth: 3,
            auth_events: JSON.stringify([]),
            prev_events: JSON.stringify(["$hist1"]),
            hashes: null,
            signatures: null,
          },
        ],
        [
          "$hist1",
          {
            event_id: "$hist1",
            room_id: "!room:test",
            sender: "@alice:test",
            event_type: "m.room.history_visibility",
            state_key: "",
            content: JSON.stringify({ history_visibility: "shared" }),
            origin_server_ts: 2,
            depth: 2,
            auth_events: JSON.stringify([]),
            prev_events: JSON.stringify(["$start"]),
            hashes: null,
            signatures: null,
          },
        ],
        [
          "$start",
          {
            event_id: "$start",
            room_id: "!room:test",
            sender: "@alice:test",
            event_type: "m.room.create",
            state_key: "",
            content: JSON.stringify({ creator: "@alice:test" }),
            origin_server_ts: 1,
            depth: 1,
            auth_events: JSON.stringify([]),
            prev_events: JSON.stringify([]),
            hashes: null,
            signatures: null,
          },
        ],
      ]),
      historyRows: [
        {
          event_id: "$hist1",
          origin_server_ts: 2,
          depth: 2,
          content: JSON.stringify({ history_visibility: "shared" }),
        },
        {
          event_id: "$hist2",
          origin_server_ts: 3,
          depth: 3,
          content: JSON.stringify({ history_visibility: "shared" }),
        },
      ],
      membershipRows: [
        {
          event_id: "$latest",
          origin_server_ts: 4,
          depth: 4,
          state_key: "@charlie:remote.test",
          content: JSON.stringify({ membership: "join" }),
        },
      ],
    });

    const result = await service.getMissingEvents(db, {
      roomId: "!room:test",
      earliestEvents: ["$start"],
      latestEvents: ["$latest"],
      limit: 10,
      minDepth: 0,
      requestingServer: "remote.test",
      roomVersion: "10",
    });

    expect(result.map((event) => event.event_id)).toEqual(["$hist1"]);
  });
});

describe("EventQueryService.getVisibleEventForUser", () => {
  it("hides events from before an invite under invited history visibility", async () => {
    const service = new EventQueryService();
    const db = createMissingEventsDb({
      events: new Map<string, Record<string, unknown>>([
        [
          "$message",
          {
            event_id: "$message",
            room_id: "!room:test",
            sender: "@alice:test",
            event_type: "m.room.message",
            state_key: null,
            content: JSON.stringify({ body: "hidden", msgtype: "m.text" }),
            origin_server_ts: 2,
            depth: 2,
            auth_events: JSON.stringify([]),
            prev_events: JSON.stringify(["$create"]),
            hashes: null,
            signatures: null,
          },
        ],
      ]),
      historyRows: [
        {
          event_id: "$hist",
          origin_server_ts: 1,
          depth: 1,
          content: JSON.stringify({ history_visibility: "invited" }),
        },
      ],
      membershipRows: [
        {
          event_id: "$invite",
          origin_server_ts: 3,
          depth: 3,
          state_key: "@bob:test",
          content: JSON.stringify({ membership: "invite" }),
        },
        {
          event_id: "$join",
          origin_server_ts: 4,
          depth: 4,
          state_key: "@bob:test",
          content: JSON.stringify({ membership: "join" }),
        },
      ],
    });

    const event = await service.getVisibleEventForUser(db, "!room:test", "$message", "@bob:test");
    expect(event).toBeNull();
  });

  it("allows events sent after an invite under invited history visibility", async () => {
    const service = new EventQueryService();
    const db = createMissingEventsDb({
      events: new Map<string, Record<string, unknown>>([
        [
          "$message",
          {
            event_id: "$message",
            room_id: "!room:test",
            sender: "@alice:test",
            event_type: "m.room.message",
            state_key: null,
            content: JSON.stringify({ body: "visible", msgtype: "m.text" }),
            origin_server_ts: 4,
            depth: 4,
            auth_events: JSON.stringify([]),
            prev_events: JSON.stringify(["$invite"]),
            hashes: null,
            signatures: null,
          },
        ],
      ]),
      historyRows: [
        {
          event_id: "$hist",
          origin_server_ts: 1,
          depth: 1,
          content: JSON.stringify({ history_visibility: "invited" }),
        },
      ],
      membershipRows: [
        {
          event_id: "$invite",
          origin_server_ts: 3,
          depth: 3,
          state_key: "@bob:test",
          content: JSON.stringify({ membership: "invite" }),
        },
        {
          event_id: "$join",
          origin_server_ts: 5,
          depth: 5,
          state_key: "@bob:test",
          content: JSON.stringify({ membership: "join" }),
        },
      ],
    });

    const event = await service.getVisibleEventForUser(db, "!room:test", "$message", "@bob:test");
    expect(event?.event_id).toBe("$message");
  });

  it("allows world-readable events without membership", async () => {
    const service = new EventQueryService();
    const db = createMissingEventsDb({
      events: new Map<string, Record<string, unknown>>([
        [
          "$message",
          {
            event_id: "$message",
            room_id: "!room:test",
            sender: "@alice:test",
            event_type: "m.room.message",
            state_key: null,
            content: JSON.stringify({ body: "public", msgtype: "m.text" }),
            origin_server_ts: 2,
            depth: 2,
            auth_events: JSON.stringify([]),
            prev_events: JSON.stringify(["$create"]),
            hashes: null,
            signatures: null,
          },
        ],
      ]),
      historyRows: [
        {
          event_id: "$hist",
          origin_server_ts: 1,
          depth: 1,
          content: JSON.stringify({ history_visibility: "world_readable" }),
        },
      ],
      membershipRows: [],
    });

    const event = await service.getVisibleEventForUser(
      db,
      "!room:test",
      "$message",
      "@charlie:test",
    );
    expect(event?.event_id).toBe("$message");
  });

  it("hides rejected events even if they were persisted", async () => {
    const service = new EventQueryService();
    const db = createMissingEventsDb({
      events: new Map<string, Record<string, unknown>>([
        [
          "$message",
          {
            event_id: "$message",
            room_id: "!room:test",
            sender: "@alice:test",
            event_type: "m.room.message",
            state_key: null,
            content: JSON.stringify({ body: "hidden", msgtype: "m.text" }),
            origin_server_ts: 2,
            depth: 2,
            auth_events: JSON.stringify([]),
            prev_events: JSON.stringify(["$create"]),
            hashes: null,
            signatures: null,
          },
        ],
      ]),
      historyRows: [
        {
          event_id: "$hist",
          origin_server_ts: 1,
          depth: 1,
          content: JSON.stringify({ history_visibility: "world_readable" }),
        },
      ],
      membershipRows: [],
      processedPdus: new Map([["$message", { accepted: 0 }]]),
    });

    const event = await service.getVisibleEventForUser(
      db,
      "!room:test",
      "$message",
      "@charlie:test",
    );
    expect(event).toBeNull();
  });
});
