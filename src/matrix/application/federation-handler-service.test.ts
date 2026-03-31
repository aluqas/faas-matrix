import { describe, expect, it } from "vitest";
import type { FederationRepository } from "../repositories/interfaces";
import {
  handleFederationDeviceListEdu,
  handleFederationDirectToDeviceEdu,
  handleFederationPresenceEdu,
  handleFederationTypingEdu,
} from "./federation-handler-service";

class FakeFederationRepository implements Pick<
  FederationRepository,
  "upsertPresence" | "upsertRemoteDeviceList"
> {
  presenceUpdates: Array<{
    userId: string;
    presence: string;
    statusMessage: string | null;
    lastActiveTs: number;
    currentlyActive: boolean;
  }> = [];

  deviceListUpdates: Array<{
    userId: string;
    deviceId: string;
    streamId: number;
    keys: Record<string, unknown> | null;
    displayName?: string;
    deleted?: boolean;
  }> = [];

  async upsertPresence(
    userId: string,
    presence: string,
    statusMessage: string | null,
    lastActiveTs: number,
    currentlyActive: boolean,
  ) {
    this.presenceUpdates.push({
      userId,
      presence,
      statusMessage,
      lastActiveTs,
      currentlyActive,
    });
  }

  async upsertRemoteDeviceList(
    userId: string,
    deviceId: string,
    streamId: number,
    keys: Record<string, unknown> | null,
    displayName?: string,
    deleted?: boolean,
  ) {
    this.deviceListUpdates.push({
      userId,
      deviceId,
      streamId,
      keys,
      displayName,
      deleted,
    });
  }
}

class FakeD1Database {
  streamPosition = 0;
  devicesByUser = new Map<string, string[]>();
  toDeviceMessages: Array<{
    recipientUserId: string;
    recipientDeviceId: string;
    senderUserId: string;
    eventType: string;
    content: string;
    messageId: string;
    streamPosition: number;
  }> = [];

  prepare(query: string) {
    let boundArgs: unknown[] = [];

    return {
      bind(...args: unknown[]) {
        boundArgs = args;
        return this;
      },
      first: async () => {
        if (query.includes("UPDATE stream_positions")) {
          this.streamPosition += 1;
          return { position: this.streamPosition };
        }

        return null;
      },
      all: async () => {
        if (query.includes("SELECT device_id FROM devices")) {
          const userId = boundArgs[0] as string;
          return {
            results: (this.devicesByUser.get(userId) ?? []).map((deviceId) => ({ device_id: deviceId })),
          };
        }

        return { results: [] };
      },
      run: async () => {
        if (query.includes("INSERT INTO to_device_messages")) {
          this.toDeviceMessages.push({
            recipientUserId: boundArgs[0] as string,
            recipientDeviceId: boundArgs[1] as string,
            senderUserId: boundArgs[2] as string,
            eventType: boundArgs[3] as string,
            content: boundArgs[4] as string,
            messageId: boundArgs[5] as string,
            streamPosition: boundArgs[6] as number,
          });
        }

        return { meta: { changes: 1 } };
      },
    };
  }
}

describe("federation-handler-service", () => {
  it("applies presence EDUs through the repository", async () => {
    const repository = new FakeFederationRepository();

    await handleFederationPresenceEdu(repository, 10_000, {
      push: [
        {
          user_id: "@alice:remote",
          presence: "online",
          status_msg: "Here",
          last_active_ago: 500,
          currently_active: true,
        },
      ],
    });

    expect(repository.presenceUpdates).toEqual([
      {
        userId: "@alice:remote",
        presence: "online",
        statusMessage: "Here",
        lastActiveTs: 9_500,
        currentlyActive: true,
      },
    ]);
  });

  it("applies remote device-list EDUs through the repository", async () => {
    const repository = new FakeFederationRepository();

    await handleFederationDeviceListEdu(repository, {
      user_id: "@alice:remote",
      device_id: "DEVICE",
      stream_id: 9,
      device_display_name: "Phone",
      keys: { user_id: "@alice:remote" },
      deleted: false,
    });

    expect(repository.deviceListUpdates).toEqual([
      {
        userId: "@alice:remote",
        deviceId: "DEVICE",
        streamId: 9,
        keys: { user_id: "@alice:remote" },
        displayName: "Phone",
        deleted: false,
      },
    ]);
  });

  it("routes typing EDUs to realtime room state", async () => {
    const calls: Array<{ roomId: string; userId: string; typing: boolean; timeoutMs?: number }> = [];

    await handleFederationTypingEdu(
      {
        async notifyRoomEvent() {},
        async waitForUserEvents() {
          return { hasEvents: false };
        },
        async setRoomTyping(roomId: string, userId: string, typing: boolean, timeoutMs?: number) {
          calls.push({ roomId, userId, typing, timeoutMs });
        },
      },
      {
        room_id: "!room:hs1",
        user_id: "@alice:remote",
        typing: true,
        timeout: 12_000,
      },
    );

    expect(calls).toEqual([
      {
        roomId: "!room:hs1",
        userId: "@alice:remote",
        typing: true,
        timeoutMs: 12_000,
      },
    ]);
  });

  it("stores m.direct_to_device EDUs for local recipient devices", async () => {
    const db = new FakeD1Database();
    db.devicesByUser.set("@bob:test", ["DEVICE1", "DEVICE2"]);

    await handleFederationDirectToDeviceEdu(db as unknown as D1Database, "remote.example", {
      sender: "@alice:remote.example",
      type: "m.room_key",
      message_id: "msg-1",
      messages: {
        "@bob:test": {
          "*": {
            algorithm: "m.megolm.v1.aes-sha2",
          },
        },
      },
    });

    expect(db.toDeviceMessages).toHaveLength(2);
    expect(db.toDeviceMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          recipientUserId: "@bob:test",
          recipientDeviceId: "DEVICE1",
          senderUserId: "@alice:remote.example",
          eventType: "m.room_key",
          messageId: "msg-1",
        }),
        expect.objectContaining({
          recipientUserId: "@bob:test",
          recipientDeviceId: "DEVICE2",
          senderUserId: "@alice:remote.example",
          eventType: "m.room_key",
          messageId: "msg-1",
        }),
      ]),
    );
  });
});
