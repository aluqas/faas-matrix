import { describe, expect, it } from "vitest";
import { resolveSharedServersWithPartialState } from "./shared-servers";

describe("resolveSharedServersWithPartialState", () => {
  it("keeps partial-state servers for active joins", () => {
    expect(
      resolveSharedServersWithPartialState({
        sharedServers: ["local.test", "hs2"],
        persistedJoins: [
          {
            roomId: "!room:test",
            userId: "@alice:test",
            eventId: "$persisted",
            startedAt: 1,
            serversInRoom: ["hs3"],
          },
        ],
        kvJoins: [
          {
            roomId: "!room:test",
            userId: "@alice:test",
            eventId: "$kv",
            startedAt: 2,
            serversInRoom: ["hs4"],
          },
        ],
        completedJoins: [],
      }),
    ).toEqual(["local.test", "hs2", "hs3", "hs4"]);
  });

  it("drops persisted partial-state metadata for completed rooms without an active marker", () => {
    expect(
      resolveSharedServersWithPartialState({
        sharedServers: ["local.test", "hs2"],
        persistedJoins: [
          {
            roomId: "!room:test",
            userId: "@alice:test",
            eventId: "$persisted",
            startedAt: 1,
            serversInRoom: ["hs3"],
          },
        ],
        kvJoins: [],
        completedJoins: [
          {
            roomId: "!room:test",
            userId: "@alice:test",
            eventId: "$done",
            startedAt: 3,
            serversInRoom: ["hs3", "hs4"],
          },
        ],
      }),
    ).toEqual(["local.test", "hs2"]);
  });

  it("keeps active partial-state metadata until the active marker clears", () => {
    expect(
      resolveSharedServersWithPartialState({
        sharedServers: ["local.test", "hs2"],
        persistedJoins: [
          {
            roomId: "!room:test",
            userId: "@alice:test",
            eventId: "$persisted",
            startedAt: 1,
            serversInRoom: ["hs3"],
          },
        ],
        kvJoins: [
          {
            roomId: "!room:test",
            userId: "@alice:test",
            eventId: "$kv",
            startedAt: 2,
            serversInRoom: ["hs4"],
          },
        ],
        completedJoins: [
          {
            roomId: "!room:test",
            userId: "@alice:test",
            eventId: "$done",
            startedAt: 3,
            serversInRoom: ["hs3", "hs4"],
          },
        ],
      }),
    ).toEqual(["local.test", "hs2", "hs3", "hs4"]);
  });
});
