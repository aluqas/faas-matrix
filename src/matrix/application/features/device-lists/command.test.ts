import { describe, expect, it } from "vitest";
import { publishDeviceListUpdatesForNewlySharedServers } from "./command";
import type { DeviceListJoinUpdatePorts } from "./contracts";

function createPorts(
  overrides: Partial<DeviceListJoinUpdatePorts> = {},
): DeviceListJoinUpdatePorts & {
  sent: Array<{ destination: string; eduType: string; content: Record<string, unknown> }>;
} {
  const sent: Array<{ destination: string; eduType: string; content: Record<string, unknown> }> =
    [];

  return {
    localServerName: "hs1",
    now: () => 1000,
    async getSharedRemoteServers() {
      return ["hs2", "hs3"];
    },
    async getUserDevices() {
      return [{ device_id: "A", display_name: "Alpha" }, { device_id: "B" }];
    },
    async getStoredDeviceKeys(userId, deviceId) {
      return {
        user_id: userId,
        device_id: deviceId,
        keys: {
          [`ed25519:${deviceId}`]: `key-${deviceId}`,
        },
        unsigned: deviceId === "A" ? { device_display_name: "Display Alpha" } : {},
      };
    },
    async queueEdu(destination, eduType, content) {
      sent.push({ destination, eduType, content });
    },
    ...overrides,
    sent,
  };
}

describe("publishDeviceListUpdatesForNewlySharedServers", () => {
  it("queues m.device_list_update for each device on newly shared servers", async () => {
    const ports = createPorts();

    const result = await publishDeviceListUpdatesForNewlySharedServers(
      {
        userId: "@alice:hs1",
        previouslySharedServers: ["hs2"],
      },
      ports,
    );

    expect(result).toEqual({
      destinations: ["hs3"],
      sentCount: 2,
      deviceCount: 2,
    });
    expect(ports.sent).toHaveLength(2);
    expect(ports.sent[0]).toMatchObject({
      destination: "hs3",
      eduType: "m.device_list_update",
      content: {
        user_id: "@alice:hs1",
        device_id: "A",
        device_display_name: "Display Alpha",
        deleted: false,
      },
    });
    expect(ports.sent[1]?.content["stream_id"]).toBe(1001);
  });

  it("sends updates without stored keys and avoids sending when no new servers exist", async () => {
    const noDestinationPorts = createPorts({
      async getSharedRemoteServers() {
        return ["hs1", "hs2"];
      },
    });

    const noDestinationResult = await publishDeviceListUpdatesForNewlySharedServers(
      {
        userId: "@alice:hs1",
        previouslySharedServers: ["hs2"],
      },
      noDestinationPorts,
    );

    expect(noDestinationResult.sentCount).toBe(0);
    expect(noDestinationPorts.sent).toHaveLength(0);

    const missingKeyPorts = createPorts({
      async getStoredDeviceKeys(userId, deviceId) {
        if (deviceId === "B") {
          return null;
        }
        return {
          user_id: userId,
          device_id: deviceId,
          keys: { [`ed25519:${deviceId}`]: `key-${deviceId}` },
        };
      },
    });

    const missingKeyResult = await publishDeviceListUpdatesForNewlySharedServers(
      {
        userId: "@alice:hs1",
        previouslySharedServers: [],
      },
      missingKeyPorts,
    );

    expect(missingKeyResult).toEqual({
      destinations: ["hs2", "hs3"],
      sentCount: 4,
      deviceCount: 2,
    });
    expect(missingKeyPorts.sent).toHaveLength(4);
    expect(missingKeyPorts.sent[1]).toMatchObject({
      destination: "hs2",
      eduType: "m.device_list_update",
      content: {
        user_id: "@alice:hs1",
        device_id: "B",
        deleted: false,
      },
    });
    expect(missingKeyPorts.sent[1]?.content).not.toHaveProperty("keys");
  });
});
