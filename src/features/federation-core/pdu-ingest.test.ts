import { describe, expect, it } from "vitest";
import { shouldDeferPartialStateMembershipAuthFailure } from "./pdu-ingest";

describe("partial-state membership auth deferral", () => {
  it("defers kick-style membership auth failures while partial state is incomplete", () => {
    expect(
      shouldDeferPartialStateMembershipAuthFailure(
        {
          type: "m.room.member",
          sender: "@alice:test",
          state_key: "@bob:test",
          content: { membership: "leave" },
        },
        "Insufficient power level to kick",
      ),
    ).toBe(true);
    expect(
      shouldDeferPartialStateMembershipAuthFailure(
        {
          type: "m.room.member",
          sender: "@alice:test",
          state_key: "@bob:test",
          content: { membership: "leave" },
        },
        "Cannot kick user with equal or higher power",
      ),
    ).toBe(true);
  });

  it("defers self-leave auth failures when partial state omitted the prior join", () => {
    expect(
      shouldDeferPartialStateMembershipAuthFailure(
        {
          type: "m.room.member",
          sender: "@elsie:remote.test",
          state_key: "@elsie:remote.test",
          content: { membership: "leave" },
        },
        "Not a member of the room",
      ),
    ).toBe(true);
  });

  it("does not defer unrelated auth failures or non-membership events", () => {
    expect(
      shouldDeferPartialStateMembershipAuthFailure(
        {
          type: "m.room.message",
          sender: "@alice:test",
          content: {},
        },
        "Insufficient power level to kick",
      ),
    ).toBe(false);
    expect(
      shouldDeferPartialStateMembershipAuthFailure(
        {
          type: "m.room.member",
          sender: "@alice:test",
          state_key: "@alice:test",
          content: { membership: "leave" },
        },
        "Room is tombstoned",
      ),
    ).toBe(false);
    expect(
      shouldDeferPartialStateMembershipAuthFailure(
        {
          type: "m.room.member",
          sender: "@alice:test",
          state_key: "@bob:test",
          content: { membership: "leave" },
        },
        "Not a member of the room",
      ),
    ).toBe(false);
  });
});
