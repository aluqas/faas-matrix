import { describe, expect, it, vi, afterEach } from "vitest";
import { Effect } from "effect";
import { logError, logInfo, withLogContext } from "./logging";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("logging", () => {
  it("emits structured JSON and redacts sensitive fields", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await Effect.runPromise(
      logInfo(
        "presence.command.start",
        {
          component: "presence",
          operation: "command",
          user_id: "@alice:test",
        },
        {
          access_token: "secret",
          nested: {
            refresh_token: "nested-secret",
          },
        },
      ),
    );

    expect(logSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(logSpy.mock.calls[0][0] as string) as Record<string, unknown>;
    expect(payload["event"]).toBe("presence.command.start");
    expect(payload["component"]).toBe("presence");
    expect(payload["user_id"]).toBe("@alice:test");
    expect(payload["access_token"]).toBe("[redacted]");
    expect(payload["nested"]).toEqual({ refresh_token: "[redacted]" });
  });

  it("adds serialized error fields and respects debug gating", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logger = withLogContext({
      component: "sync",
      operation: "project",
      debugEnabled: false,
    });

    await Effect.runPromise(logger.debug("sync.project.result", { event_count: 1 }));
    expect(logSpy).not.toHaveBeenCalled();

    await Effect.runPromise(
      logError(
        "sync.project.error",
        {
          component: "sync",
          operation: "project",
        },
        new Error("boom"),
      ),
    );

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(errorSpy.mock.calls[0][0] as string) as Record<string, unknown>;
    expect(payload["event"]).toBe("sync.project.error");
    expect(payload["error_name"]).toBe("Error");
    expect(payload["error_message"]).toBe("boom");
    expect(typeof payload["error_stack"]).toBe("string");
  });
});
