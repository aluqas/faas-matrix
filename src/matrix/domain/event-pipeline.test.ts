import { describe, expect, it } from "vitest";
import { DefaultEventPipeline } from "./event-pipeline";

describe("DefaultEventPipeline", () => {
  it("runs stages in order and records trace", async () => {
    const pipeline = new DefaultEventPipeline();
    const result = await pipeline.execute({
      input: { value: 1 },
      validate: () => {},
      resolveAuth: () => ({ userId: "@alice:test" }),
      authorize: () => {},
      buildEvent: () => ({ event_id: "$1" }),
      persist: () => ({ ok: true }),
      fanout: async () => {},
      notifyFederation: async () => {},
    });

    expect(result.trace).toEqual([
      "validate",
      "resolveAuth",
      "authorize",
      "buildEvent",
      "persist",
      "fanout",
      "notifyFederation",
    ]);
  });

  it("captures post-commit failures without rolling back persist", async () => {
    const pipeline = new DefaultEventPipeline();
    const result = await pipeline.execute({
      input: { value: 1 },
      validate: () => {},
      resolveAuth: () => ({ userId: "@alice:test" }),
      authorize: () => {},
      buildEvent: () => ({ event_id: "$1" }),
      persist: () => ({ eventId: "$1" }),
      fanout: () => {
        throw new Error("fanout failed");
      },
    });

    expect(result.persisted).toEqual({ eventId: "$1" });
    expect(result.postCommitErrors).toHaveLength(1);
    expect(result.postCommitErrors[0]?.stage).toBe("fanout");
  });
});
