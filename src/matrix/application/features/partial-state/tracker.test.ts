import { describe, expect, it } from "vitest";
import {
  clearPartialStateJoin,
  getPartialStateJoinCompletion,
  getPartialStateJoin,
  getPartialStateJoinForRoom,
  listPartialStateJoinCompletionsForUser,
  listPartialStateJoinsForUser,
  markPartialStateJoinCompleted,
  markPartialStateJoin,
  takePartialStateJoinCompletion,
} from "./tracker";

class FakeKvNamespace {
  private readonly values = new Map<string, string>();

  get(key: string, type?: "json"): Promise<unknown> {
    const value = this.values.get(key);
    if (!value) {
      return null;
    }

    if (type === "json") {
      return JSON.parse(value) as unknown;
    }

    return value;
  }

  put(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  delete(key: string): Promise<void> {
    this.values.delete(key);
  }

  list(options?: { prefix?: string; cursor?: string }) {
    const prefix = options?.prefix ?? "";
    return {
      keys: Array.from(this.values.keys())
        .filter((key) => key.startsWith(prefix))
        .map((name) => ({ name })),
      list_complete: true,
      cursor: "",
    };
  }
}

describe("partial-state tracker", () => {
  it("stores and loads a partial-state join marker", async () => {
    const cache = new FakeKvNamespace() as unknown as KVNamespace;

    await markPartialStateJoin(cache, {
      roomId: "!room:test",
      userId: "@alice:test",
      eventId: "$prev",
      remoteServer: "hs2",
      serversInRoom: ["hs2", "hs3"],
      startedAt: 1234,
    });

    await expect(getPartialStateJoin(cache, "@alice:test", "!room:test")).resolves.toEqual({
      roomId: "!room:test",
      userId: "@alice:test",
      eventId: "$prev",
      remoteServer: "hs2",
      serversInRoom: ["hs2", "hs3"],
      startedAt: 1234,
    });
    await expect(getPartialStateJoinForRoom(cache, "!room:test")).resolves.toEqual({
      roomId: "!room:test",
      userId: "@alice:test",
      eventId: "$prev",
      remoteServer: "hs2",
      serversInRoom: ["hs2", "hs3"],
      startedAt: 1234,
    });
  });

  it("clears a partial-state join marker", async () => {
    const cache = new FakeKvNamespace() as unknown as KVNamespace;

    await markPartialStateJoin(cache, {
      roomId: "!room:test",
      userId: "@alice:test",
      eventId: "$prev",
      startedAt: 1234,
    });
    await clearPartialStateJoin(cache, "@alice:test", "!room:test");

    await expect(getPartialStateJoin(cache, "@alice:test", "!room:test")).resolves.toBeNull();
    await expect(getPartialStateJoinForRoom(cache, "!room:test")).resolves.toBeNull();
  });

  it("stores and consumes a partial-state completion marker", async () => {
    const cache = new FakeKvNamespace() as unknown as KVNamespace;

    await markPartialStateJoinCompleted(cache, {
      roomId: "!room:test",
      userId: "@alice:test",
      eventId: "$event",
      startedAt: 1,
      remoteServer: "remote.test",
      serversInRoom: ["hs2", "hs3"],
    });

    await expect(
      takePartialStateJoinCompletion(cache, "@alice:test", "!room:test"),
    ).resolves.toEqual({
      roomId: "!room:test",
      userId: "@alice:test",
      eventId: "$event",
      startedAt: 1,
      remoteServer: "remote.test",
      serversInRoom: ["hs2", "hs3"],
    });
    await expect(
      takePartialStateJoinCompletion(cache, "@alice:test", "!room:test"),
    ).resolves.toBeNull();
  });

  it("reads and lists partial-state completion markers without consuming them", async () => {
    const cache = new FakeKvNamespace() as unknown as KVNamespace;

    await markPartialStateJoinCompleted(cache, {
      roomId: "!one:test",
      userId: "@alice:test",
      eventId: "$one",
      startedAt: 1,
      serversInRoom: ["hs2"],
    });
    await markPartialStateJoinCompleted(cache, {
      roomId: "!two:test",
      userId: "@alice:test",
      eventId: "$two",
      startedAt: 2,
      serversInRoom: ["hs3"],
    });
    await markPartialStateJoinCompleted(cache, {
      roomId: "!three:test",
      userId: "@bob:test",
      eventId: "$three",
      startedAt: 3,
    });

    await expect(getPartialStateJoinCompletion(cache, "@alice:test", "!one:test")).resolves.toEqual(
      {
        roomId: "!one:test",
        userId: "@alice:test",
        eventId: "$one",
        startedAt: 1,
        serversInRoom: ["hs2"],
      },
    );
    await expect(listPartialStateJoinCompletionsForUser(cache, "@alice:test")).resolves.toEqual([
      {
        roomId: "!one:test",
        userId: "@alice:test",
        eventId: "$one",
        startedAt: 1,
        serversInRoom: ["hs2"],
      },
      {
        roomId: "!two:test",
        userId: "@alice:test",
        eventId: "$two",
        startedAt: 2,
        serversInRoom: ["hs3"],
      },
    ]);
    await expect(getPartialStateJoinCompletion(cache, "@alice:test", "!one:test")).resolves.toEqual(
      {
        roomId: "!one:test",
        userId: "@alice:test",
        eventId: "$one",
        startedAt: 1,
        serversInRoom: ["hs2"],
      },
    );
  });

  it("lists partial-state joins for a user", async () => {
    const cache = new FakeKvNamespace() as unknown as KVNamespace;

    await markPartialStateJoin(cache, {
      roomId: "!one:test",
      userId: "@alice:test",
      eventId: "$one",
      startedAt: 1,
      serversInRoom: ["hs2"],
    });
    await markPartialStateJoin(cache, {
      roomId: "!two:test",
      userId: "@alice:test",
      eventId: "$two",
      startedAt: 2,
      serversInRoom: ["hs3"],
    });
    await markPartialStateJoin(cache, {
      roomId: "!three:test",
      userId: "@bob:test",
      eventId: "$three",
      startedAt: 3,
    });

    await expect(listPartialStateJoinsForUser(cache, "@alice:test")).resolves.toEqual([
      {
        roomId: "!one:test",
        userId: "@alice:test",
        eventId: "$one",
        startedAt: 1,
        serversInRoom: ["hs2"],
      },
      {
        roomId: "!two:test",
        userId: "@alice:test",
        eventId: "$two",
        startedAt: 2,
        serversInRoom: ["hs3"],
      },
    ]);
  });
});
