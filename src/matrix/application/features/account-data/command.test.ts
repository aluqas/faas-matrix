import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { runClientEffect } from "../../effect-runtime";
import {
  deleteGlobalAccountDataEffect,
  putGlobalAccountDataEffect,
  putRoomAccountDataEffect,
  type AccountDataCommandPorts,
} from "./command";

function createPorts(recorder: string[] = []): AccountDataCommandPorts {
  return {
    putGlobalAccountData: (_userId, eventType) =>
      Effect.sync(() => {
        recorder.push(`put-global:${eventType}`);
      }),
    deleteGlobalAccountData: (_userId, eventType) =>
      Effect.sync(() => {
        recorder.push(`delete-global:${eventType}`);
      }),
    putRoomAccountData: (_userId, roomId, eventType) =>
      Effect.sync(() => {
        recorder.push(`put-room:${roomId}:${eventType}`);
      }),
    deleteRoomAccountData: (_userId, roomId, eventType) =>
      Effect.sync(() => {
        recorder.push(`delete-room:${roomId}:${eventType}`);
      }),
    isUserJoinedToRoom: () => Effect.succeed(true),
    notifyAccountDataChange: ({ roomId, eventType }) =>
      Effect.sync(() => {
        recorder.push(`notify:${roomId ?? "global"}:${eventType}`);
      }),
  };
}

describe("account-data command effect", () => {
  it("stores and notifies global account data", async () => {
    const recorder: string[] = [];
    await runClientEffect(
      putGlobalAccountDataEffect(createPorts(recorder), {
        authUserId: "@alice:test",
        targetUserId: "@alice:test",
        eventType: "m.direct",
        content: { "@alice:test": ["!room:test"] },
      }),
    );
    expect(recorder).toEqual(["put-global:m.direct", "notify:global:m.direct"]);
  });

  it("deletes and notifies global account data", async () => {
    const recorder: string[] = [];
    await runClientEffect(
      deleteGlobalAccountDataEffect(createPorts(recorder), {
        authUserId: "@alice:test",
        targetUserId: "@alice:test",
        eventType: "m.direct",
      }),
    );
    expect(recorder).toEqual(["delete-global:m.direct", "notify:global:m.direct"]);
  });

  it("requires room membership before storing room account data", async () => {
    const recorder: string[] = [];
    await expect(
      runClientEffect(
        putRoomAccountDataEffect(
          {
            ...createPorts(recorder),
            isUserJoinedToRoom: () => Effect.succeed(false),
          },
          {
            authUserId: "@alice:test",
            targetUserId: "@alice:test",
            roomId: "!room:test",
            eventType: "m.tag",
            content: { tags: {} },
          },
        ),
      ),
    ).rejects.toMatchObject({
      errcode: "M_FORBIDDEN",
    });
  });
});
