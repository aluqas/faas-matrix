import { describe, expect, it } from "vitest";
import type { PresenceCommandInput, PresenceEduContent } from "./contracts";
import { executePresenceCommand } from "./command";

describe("presence command", () => {
  it("persists presence locally and queues remote EDUs once per remote server", async () => {
    const persisted: PresenceCommandInput[] = [];
    const queued: Array<{ destination: string; content: PresenceEduContent }> = [];

    await executePresenceCommand(
      {
        userId: "@alice:test",
        presence: "online",
        statusMessage: "Here",
        now: 123,
      },
      {
        localServerName: "test",
        persistPresence(input) {
          persisted.push(input);
        },
        resolveInterestedServers() {
          return ["test", "remote-a", "remote-a", "remote-b"];
        },
        queueEdu(destination: string, content: PresenceEduContent) {
          queued.push({ destination, content });
        },
      },
    );

    expect(persisted).toHaveLength(1);
    expect(queued).toEqual([
      {
        destination: "remote-a",
        content: {
          push: [
            {
              user_id: "@alice:test",
              presence: "online",
              status_msg: "Here",
              last_active_ago: 0,
              currently_active: true,
            },
          ],
        },
      },
      {
        destination: "remote-b",
        content: {
          push: [
            {
              user_id: "@alice:test",
              presence: "online",
              status_msg: "Here",
              last_active_ago: 0,
              currently_active: true,
            },
          ],
        },
      },
    ]);
  });
});
