import { describe, expect, it, vi } from "vitest";
import { queryProfileResponse } from "./profile-query";

describe("profile query orchestrator", () => {
  it("uses the local repository path for local users", async () => {
    const getLocalProfile = vi.fn(async () => ({
      displayname: "Alice",
      avatar_url: "mxc://test/alice",
    }));
    const fetchRemoteProfile = vi.fn(async () => null);

    await expect(
      queryProfileResponse({
        userId: "@alice:test",
        localServerName: "test",
        getLocalProfile,
        fetchRemoteProfile,
      }),
    ).resolves.toEqual({
      displayname: "Alice",
      avatar_url: "mxc://test/alice",
    });

    expect(getLocalProfile).toHaveBeenCalledWith("@alice:test");
    expect(fetchRemoteProfile).not.toHaveBeenCalled();
  });

  it("uses the remote gateway path for remote users", async () => {
    const getLocalProfile = vi.fn(async () => null);
    const fetchRemoteProfile = vi.fn(async () => ({
      displayname: "Bob",
      avatar_url: "mxc://remote/bob",
    }));

    await expect(
      queryProfileResponse({
        userId: "@bob:remote.test",
        field: "displayname",
        localServerName: "test",
        getLocalProfile,
        fetchRemoteProfile,
      }),
    ).resolves.toEqual({
      displayname: "Bob",
      avatar_url: "mxc://remote/bob",
    });

    expect(fetchRemoteProfile).toHaveBeenCalledWith(
      "remote.test",
      "@bob:remote.test",
      "displayname",
    );
    expect(getLocalProfile).not.toHaveBeenCalled();
  });
});
