import { describe, expect, it } from "vitest";
import { shouldDeferPartialStateMembershipAuthFailure } from "./pdu-ingest";

describe("partial-state membership auth deferral", () => {
  it("defers kick-style membership auth failures while partial state is incomplete", () => {
    expect(
      shouldDeferPartialStateMembershipAuthFailure(
        "m.room.member",
        "Insufficient power level to kick",
      ),
    ).toBe(true);
    expect(
      shouldDeferPartialStateMembershipAuthFailure(
        "m.room.member",
        "Cannot kick user with equal or higher power",
      ),
    ).toBe(true);
  });

  it("does not defer unrelated auth failures or non-membership events", () => {
    expect(
      shouldDeferPartialStateMembershipAuthFailure(
        "m.room.message",
        "Insufficient power level to kick",
      ),
    ).toBe(false);
    expect(
      shouldDeferPartialStateMembershipAuthFailure("m.room.member", "Room is tombstoned"),
    ).toBe(false);
  });
});
