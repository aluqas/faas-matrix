import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { deleteDeviceEffect, deleteDevicesEffect } from "./command";
import type { DeviceCommandPorts } from "./command";
import { runClientEffect } from "../../runtime/effect-runtime";

function makePorts(overrides: Partial<DeviceCommandPorts["deviceRepository"]> = {}): DeviceCommandPorts {
  return {
    localServerName: "test.local",
    deviceRepository: {
      getDevice: vi.fn(() => Effect.succeed({ deviceId: "DEVICE1", displayName: null })),
      updateDeviceDisplayName: vi.fn(() => Effect.succeed(undefined)),
      deleteDeviceAccessTokens: vi.fn(() => Effect.succeed(undefined)),
      deleteDevice: vi.fn(() => Effect.succeed(undefined)),
      deleteDevices: vi.fn(() => Effect.succeed(undefined)),
      ...overrides,
    },
    userAuth: {
      getPasswordHash: vi.fn(() => Effect.succeed("$argon2id$v=19$hashed")),
    },
    deviceKeysGateway: {
      getStoredDeviceKeys: vi.fn(() => Effect.succeed(null)),
      putStoredDeviceKeys: vi.fn(() => Effect.succeed(undefined)),
    },
    deviceKeyChanges: {
      recordChange: vi.fn(() => Effect.succeed(undefined)),
    },
    sharedServers: {
      getSharedRemoteServers: vi.fn(async () => []),
      queueEdu: vi.fn(async () => undefined),
    },
  };
}

describe("deleteDeviceEffect", () => {
  it("returns uia challenge when no auth is provided", async () => {
    const ports = makePorts();
    const result = await runClientEffect(
      deleteDeviceEffect(ports, {
        authUserId: "@alice:test.local" as ReturnType<typeof Object>,
        deviceId: "DEVICE1",
        auth: undefined,
      }),
    );
    expect(result.kind).toBe("uia");
  });

  it("returns 403 M_FORBIDDEN when UI-auth identifier does not match the auth user", async () => {
    const ports = makePorts();
    await expect(
      runClientEffect(
        deleteDeviceEffect(ports, {
          authUserId: "@alice:test.local" as never,
          deviceId: "DEVICE1",
          auth: {
            type: "m.login.password",
            password: "password",
            identifier: { type: "m.id.user", user: "@bob:test.local" },
          },
        }),
      ),
    ).rejects.toMatchObject({ errcode: "M_FORBIDDEN", status: 403 });
  });

  it("does not call deleteDevice when owner check fails", async () => {
    const deleteDevice = vi.fn(() => Effect.succeed(undefined as void));
    const deleteDeviceAccessTokens = vi.fn(() => Effect.succeed(undefined as void));
    const ports = makePorts({ deleteDevice, deleteDeviceAccessTokens });

    await expect(
      runClientEffect(
        deleteDeviceEffect(ports, {
          authUserId: "@alice:test.local" as never,
          deviceId: "DEVICE1",
          auth: {
            type: "m.login.password",
            password: "password",
            identifier: { type: "m.id.user", user: "@bob:test.local" },
          },
        }),
      ),
    ).rejects.toBeDefined();

    expect(deleteDevice).not.toHaveBeenCalled();
    expect(deleteDeviceAccessTokens).not.toHaveBeenCalled();
  });
});

describe("deleteDevicesEffect", () => {
  it("returns 403 M_FORBIDDEN when UI-auth identifier does not match the auth user", async () => {
    const ports = makePorts();
    await expect(
      runClientEffect(
        deleteDevicesEffect(ports, {
          authUserId: "@alice:test.local" as never,
          deviceIds: ["DEVICE1"],
          auth: {
            type: "m.login.password",
            password: "password",
            identifier: { type: "m.id.user", user: "@bob:test.local" },
          },
        }),
      ),
    ).rejects.toMatchObject({ errcode: "M_FORBIDDEN", status: 403 });
  });
});
