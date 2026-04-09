import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  dispatchLocalOrRemoteUserQueryEffect,
  resolveLocalOrRemoteUserTarget,
} from "./local-remote-dispatch";

describe("local remote dispatch", () => {
  it("resolves local and remote Matrix user targets", () => {
    expect(resolveLocalOrRemoteUserTarget("@alice:test", "test")).toEqual({
      userId: "@alice:test",
      serverName: "test",
      isLocal: true,
    });

    expect(resolveLocalOrRemoteUserTarget("@alice:remote.test", "test")).toEqual({
      userId: "@alice:remote.test",
      serverName: "remote.test",
      isLocal: false,
    });
  });

  it("dispatches to the matching local or remote loader", async () => {
    const localTarget = resolveLocalOrRemoteUserTarget("@alice:test", "test");
    const remoteTarget = resolveLocalOrRemoteUserTarget("@alice:remote.test", "test");

    expect(localTarget).not.toBeNull();
    expect(remoteTarget).not.toBeNull();

    const localResult = await Effect.runPromise(
      dispatchLocalOrRemoteUserQueryEffect(localTarget!, {
        loadLocal: () => Effect.succeed("local"),
        loadRemote: () => Effect.succeed("remote"),
      }),
    );
    const remoteResult = await Effect.runPromise(
      dispatchLocalOrRemoteUserQueryEffect(remoteTarget!, {
        loadLocal: () => Effect.succeed("local"),
        loadRemote: () => Effect.succeed("remote"),
      }),
    );

    expect(localResult).toBe("local");
    expect(remoteResult).toBe("remote");
  });
});
