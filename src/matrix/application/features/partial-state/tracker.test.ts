import { describe, expect, it } from "vitest";
import {
  clearPartialStateJoin,
  getPartialStateJoin,
  getPartialStateJoinForRoom,
  markPartialStateJoinCompleted,
  markPartialStateJoin,
  takePartialStateJoinCompletion,
} from "./tracker";

class FakeKvNamespace {
  private readonly values = new Map<string, string>();

  async get(key: string, type?: "json"): Promise<unknown> {
    const value = this.values.get(key);
    if (!value) {
      return null;
    }

    if (type === "json") {
      return JSON.parse(value) as unknown;
    }

    return value;
  }

  async put(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
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
      startedAt: 1234,
    });

    await expect(getPartialStateJoin(cache, "@alice:test", "!room:test")).resolves.toEqual({
      roomId: "!room:test",
      userId: "@alice:test",
      eventId: "$prev",
      remoteServer: "hs2",
      startedAt: 1234,
    });
    await expect(getPartialStateJoinForRoom(cache, "!room:test")).resolves.toEqual({
      roomId: "!room:test",
      userId: "@alice:test",
      eventId: "$prev",
      remoteServer: "hs2",
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
    });

    await expect(
      takePartialStateJoinCompletion(cache, "@alice:test", "!room:test"),
    ).resolves.toEqual({
      roomId: "!room:test",
      userId: "@alice:test",
      eventId: "$event",
      startedAt: 1,
      remoteServer: "remote.test",
    });
    await expect(
      takePartialStateJoinCompletion(cache, "@alice:test", "!room:test"),
    ).resolves.toBeNull();
  });
});
