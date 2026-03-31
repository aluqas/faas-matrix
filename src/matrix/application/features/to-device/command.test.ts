import { describe, expect, it } from "vitest";
import { dispatchToDeviceMessages } from "./command";

describe("to-device command", () => {
  it("splits local persistence from remote federation dispatch", async () => {
    const stored: Array<Record<string, unknown>> = [];
    const queued: Array<{ destination: string; content: Record<string, unknown> }> = [];
    let streamPosition = 0;

    const result = await dispatchToDeviceMessages(
      {
        senderUserId: "@alice:test",
        eventType: "m.room_key",
        txnId: "txn-1",
        messages: {
          "@bob:test": {
            "*": {
              key: "local",
            },
          },
          "@charlie:remote": {
            DEVICE: {
              key: "remote",
            },
          },
        },
      },
      {
        localServerName: "test",
        async getUserDevices() {
          return ["DEVICE1", "DEVICE2"];
        },
        async nextStreamPosition() {
          streamPosition += 1;
          return streamPosition;
        },
        async storeLocalMessage(input) {
          stored.push(input);
        },
        async queueEdu(destination, content) {
          queued.push({ destination, content });
        },
      },
    );

    expect(result.localMessages).toHaveLength(2);
    expect(stored).toEqual([
      expect.objectContaining({
        recipientUserId: "@bob:test",
        recipientDeviceId: "DEVICE1",
        senderUserId: "@alice:test",
        eventType: "m.room_key",
        streamPosition: 1,
      }),
      expect.objectContaining({
        recipientUserId: "@bob:test",
        recipientDeviceId: "DEVICE2",
        senderUserId: "@alice:test",
        eventType: "m.room_key",
        streamPosition: 2,
      }),
    ]);
    expect(queued).toEqual([
      {
        destination: "remote",
        content: {
          sender: "@alice:test",
          type: "m.room_key",
          message_id: "txn-1-remote",
          messages: {
            "@charlie:remote": {
              DEVICE: {
                key: "remote",
              },
            },
          },
        },
      },
    ]);
  });
});
