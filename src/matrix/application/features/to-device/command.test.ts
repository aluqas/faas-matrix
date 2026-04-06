import { describe, expect, it } from "vitest";
import type { DirectToDeviceEduContent } from "./contracts";
import { dispatchToDeviceMessages } from "./command";

describe("to-device command", () => {
  it("splits local persistence from remote federation dispatch", async () => {
    const stored: Array<Record<string, unknown>> = [];
    const queued: Array<{ destination: string; content: DirectToDeviceEduContent }> = [];
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
        getUserDevices() {
          return ["DEVICE1", "DEVICE2"];
        },
        nextStreamPosition() {
          streamPosition += 1;
          return streamPosition;
        },
        storeLocalMessage(input) {
          stored.push(input);
        },
        queueEdu(destination, content) {
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
