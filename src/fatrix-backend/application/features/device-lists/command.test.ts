import { describe, it, expect, vi } from "vitest";
import { publishDeviceListUpdatesForNewlySharedServers } from "./command";
import type { DeviceListJoinUpdatePorts } from "./contracts";

function makePorts(
  discoveredServers: string[],
  overrides?: Partial<DeviceListJoinUpdatePorts>,
): DeviceListJoinUpdatePorts {
  return {
    localServerName: "hs1",
    now: () => 1000,
    getSharedRemoteServers: vi.fn().mockResolvedValue(discoveredServers),
    getUserDevices: vi.fn().mockResolvedValue([{ device_id: "DEVICE1" }]),
    getStoredDeviceKeys: vi.fn().mockResolvedValue(null),
    queueEdu: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("publishDeviceListUpdatesForNewlySharedServers", () => {
  it("sends updates only to newly-shared servers (pre/post diff)", async () => {
    const ports = makePorts(["server.a", "server.b"]);
    const result = await publishDeviceListUpdatesForNewlySharedServers(
      {
        userId: "@alice:hs1",
        previouslySharedServers: ["server.a"],
      },
      ports,
    );

    // Only server.b is new; server.a was already shared
    expect(result.destinations).toEqual(["server.b"]);
    expect(result.sentCount).toBe(1);
    expect(ports.queueEdu).toHaveBeenCalledTimes(1);
    expect(ports.queueEdu).toHaveBeenCalledWith(
      "server.b",
      "m.device_list_update",
      expect.objectContaining({ user_id: "@alice:hs1", device_id: "DEVICE1" }),
    );
  });

  it("includes sharedServersAfterJoin servers even if not in encrypted rooms", async () => {
    // No encrypted-room servers discovered; the joined room (unencrypted) provides the server
    const ports = makePorts([]);
    const result = await publishDeviceListUpdatesForNewlySharedServers(
      {
        userId: "@alice:hs1",
        previouslySharedServers: [],
        sharedServersAfterJoin: ["newserver.org"],
      },
      ports,
    );

    expect(result.destinations).toEqual(["newserver.org"]);
    expect(result.sentCount).toBe(1);
    expect(ports.queueEdu).toHaveBeenCalledWith(
      "newserver.org",
      "m.device_list_update",
      expect.objectContaining({ user_id: "@alice:hs1" }),
    );
  });

  it("deduplicates when sharedServersAfterJoin overlaps with discovered servers", async () => {
    const ports = makePorts(["overlap.org"]);
    const result = await publishDeviceListUpdatesForNewlySharedServers(
      {
        userId: "@alice:hs1",
        previouslySharedServers: [],
        sharedServersAfterJoin: ["overlap.org"],
      },
      ports,
    );

    // overlap.org should only be sent to once
    expect(result.destinations).toEqual(["overlap.org"]);
    expect(result.sentCount).toBe(1);
  });

  it("sends nothing when all servers were already shared", async () => {
    const ports = makePorts(["server.a"]);
    const result = await publishDeviceListUpdatesForNewlySharedServers(
      {
        userId: "@alice:hs1",
        previouslySharedServers: ["server.a"],
      },
      ports,
    );

    expect(result.destinations).toEqual([]);
    expect(result.sentCount).toBe(0);
    expect(ports.queueEdu).not.toHaveBeenCalled();
  });
});
