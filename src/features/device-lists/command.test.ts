import { describe, expect, it } from "vitest";
import {
  publishDeviceListUpdateToSharedServers,
  publishDeviceListUpdatesForNewlySharedServers,
} from "./command";
import type { DeviceListBroadcastPorts, DeviceListJoinUpdatePorts } from "./contracts";

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
    getSharedRemoteServers() {
      return ["hs2", "hs3"];
    },
    getUserDevices() {
      return [{ device_id: "A", display_name: "Alpha" }, { device_id: "B" }];
    },
    getStoredDeviceKeys(userId, deviceId) {
      return {
        user_id: userId,
        device_id: deviceId,
        keys: {
          [`ed25519:${deviceId}`]: `key-${deviceId}`,
        },
        unsigned: deviceId === "A" ? { device_display_name: "Display Alpha" } : {},
      };
    },
    queueEdu(destination, eduType, content) {
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
      getSharedRemoteServers() {
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
      getStoredDeviceKeys(userId, deviceId) {
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

  it("unions handshake-provided shared servers with the database view", async () => {
    const ports = createPorts({
      getSharedRemoteServers() {
        return ["hs2"];
      },
    });

    const result = await publishDeviceListUpdatesForNewlySharedServers(
      {
        userId: "@alice:hs1",
        previouslySharedServers: [],
        sharedServersAfterJoin: ["hs2", "hs3", "hs4"],
      },
      ports,
    );

    expect(result).toEqual({
      destinations: ["hs2", "hs3", "hs4"],
      sentCount: 6,
      deviceCount: 2,
    });
    expect(ports.sent.map((entry) => entry.destination)).toEqual([
      "hs2",
      "hs2",
      "hs3",
      "hs3",
      "hs4",
      "hs4",
    ]);
  });
});

describe("publishDeviceListUpdateToSharedServers", () => {
  function createBroadcastPorts(
    overrides: Partial<DeviceListBroadcastPorts> = {},
  ): DeviceListBroadcastPorts & {
    sent: Array<{ destination: string; eduType: string; content: Record<string, unknown> }>;
  } {
    const sent: Array<{ destination: string; eduType: string; content: Record<string, unknown> }> =
      [];

    return {
      localServerName: "hs1",
      now: () => 2000,
      getSharedRemoteServers() {
        return ["hs1", "hs2", "hs3"];
      },
      queueEdu(destination, eduType, content) {
        sent.push({ destination, eduType, content });
      },
      ...overrides,
      sent,
    };
  }

  it("broadcasts a single device update to all currently shared remote servers", async () => {
    const ports = createBroadcastPorts();

    const result = await publishDeviceListUpdateToSharedServers(
      {
        userId: "@alice:hs1",
        deviceId: "A",
        deviceDisplayName: "Phone",
        keys: {
          user_id: "@alice:hs1",
          device_id: "A",
          keys: {
            "ed25519:A": "key-A",
          },
        },
      },
      ports,
    );

    expect(result).toEqual({
      destinations: ["hs2", "hs3"],
      sentCount: 2,
    });
    expect(ports.sent).toHaveLength(2);
    expect(ports.sent[0]).toMatchObject({
      destination: "hs2",
      eduType: "m.device_list_update",
      content: {
        user_id: "@alice:hs1",
        device_id: "A",
        device_display_name: "Phone",
        deleted: false,
        stream_id: 2000,
      },
    });
    expect(ports.sent[0]?.content).toHaveProperty("keys");
  });

  it("omits keys and display name for deleted device updates", async () => {
    const ports = createBroadcastPorts({
      getSharedRemoteServers() {
        return ["hs2"];
      },
    });

    const result = await publishDeviceListUpdateToSharedServers(
      {
        userId: "@alice:hs1",
        deviceId: "A",
        deviceDisplayName: "Phone",
        deleted: true,
      },
      ports,
    );

    expect(result).toEqual({
      destinations: ["hs2"],
      sentCount: 1,
    });
    expect(ports.sent[0]).toMatchObject({
      destination: "hs2",
      content: {
        user_id: "@alice:hs1",
        device_id: "A",
        deleted: true,
        stream_id: 2000,
      },
    });
    expect(ports.sent[0]?.content).not.toHaveProperty("keys");
    expect(ports.sent[0]?.content).not.toHaveProperty("device_display_name");
  });
});
