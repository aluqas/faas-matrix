import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { queueFederationEduWithPorts } from "./federation-edu-queue";

describe("queueFederationEduWithPorts", () => {
  it("enqueues federation EDUs through the durable queue", async () => {
    const enqueued: string[] = [];

    await queueFederationEduWithPorts(
      {
        runEffect: Effect.runPromise,
        async enqueue(destination) {
          enqueued.push(destination);
        },
      },
      "hs2",
      "m.typing",
      { user_ids: ["@alice:test"] },
    );

    expect(enqueued).toEqual(["hs2"]);
  });
});
