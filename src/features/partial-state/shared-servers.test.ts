import { describe, expect, it } from "vitest";
import {
  resolveActivePartialStateRoomIds,
  resolveEncryptedSharedServersWithPartialState,
  resolveSharedServersWithPartialState,
} from "./shared-servers";

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
            phase: "partial",
            serversInRoom: ["hs3"],
          },
        ],
        kvJoins: [
          {
            roomId: "!room:test",
            userId: "@alice:test",
            eventId: "$kv",
            startedAt: 2,
            phase: "partial",
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
            phase: "partial",
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
            phase: "complete",
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
            phase: "partial",
            serversInRoom: ["hs3"],
          },
        ],
        kvJoins: [
          {
            roomId: "!room:test",
            userId: "@alice:test",
            eventId: "$kv",
            startedAt: 2,
            phase: "partial",
            serversInRoom: ["hs4"],
          },
        ],
        completedJoins: [
          {
            roomId: "!room:test",
            userId: "@alice:test",
            eventId: "$done",
            startedAt: 3,
            phase: "complete",
            serversInRoom: ["hs3", "hs4"],
          },
        ],
      }),
    ).toEqual(["local.test", "hs2", "hs3", "hs4"]);
  });

  it("derives active partial-state room ids without completed-only rooms", () => {
    expect(
      resolveActivePartialStateRoomIds({
        persistedJoins: [
          {
            roomId: "!active:test",
            userId: "@alice:test",
            eventId: "$persisted",
            startedAt: 1,
            phase: "partial",
            serversInRoom: ["hs3"],
          },
          {
            roomId: "!completed:test",
            userId: "@alice:test",
            eventId: "$completed-persisted",
            startedAt: 1,
            phase: "partial",
            serversInRoom: ["hs4"],
          },
        ],
        kvJoins: [],
        completedJoins: [
          {
            roomId: "!completed:test",
            userId: "@alice:test",
            eventId: "$done",
            startedAt: 3,
            phase: "complete",
            serversInRoom: ["hs4"],
          },
        ],
      }),
    ).toEqual(["!active:test"]);
  });

  it("only merges partial-state servers into encrypted sharing when the marker is encrypted", () => {
    expect(
      resolveEncryptedSharedServersWithPartialState({
        sharedServers: ["local.test", "hs2"],
        persistedJoins: [
          {
            roomId: "!unencrypted:test",
            userId: "@alice:test",
            eventId: "$persisted",
            startedAt: 1,
            phase: "partial",
            serversInRoom: ["hs3"],
          },
          {
            roomId: "!encrypted:test",
            userId: "@alice:test",
            eventId: "$encrypted",
            startedAt: 2,
            phase: "partial",
            encrypted: true,
            serversInRoom: ["hs4"],
          },
        ],
        kvJoins: [],
        completedJoins: [],
      }),
    ).toEqual(["local.test", "hs2", "hs4"]);
  });
});
