import type { DeviceKeysPayload } from "../../../../fatrix-model/types/client";
import type {
  DeviceListBroadcastInput,
  DeviceListBroadcastPorts,
  DeviceListBroadcastResult,
  DeviceListJoinUpdateInput,
  DeviceListJoinUpdatePorts,
  DeviceListJoinUpdateResult,
} from "./contracts";

function getDeviceDisplayName(
  device: { display_name?: string },
  deviceKeys: DeviceKeysPayload,
): string | undefined {
  const unsignedDisplayName = deviceKeys.unsigned?.["device_display_name"];
  if (typeof unsignedDisplayName === "string") {
    return unsignedDisplayName;
  }

  return device.display_name;
}

function getDestinations(localServerName: string, sharedServers: string[]): string[] {
  return [...new Set(sharedServers)].filter((server) => server !== localServerName);
}

export async function publishDeviceListUpdateToSharedServers(
  input: DeviceListBroadcastInput,
  ports: DeviceListBroadcastPorts,
): Promise<DeviceListBroadcastResult> {
  const sharedServers = input.sharedServers ?? (await ports.getSharedRemoteServers(input.userId));
  const destinations = getDestinations(ports.localServerName, sharedServers);

  if (destinations.length === 0) {
    return {
      destinations: [],
      sentCount: 0,
    };
  }

  const content: Record<string, unknown> = {
    user_id: input.userId,
    device_id: input.deviceId,
    stream_id: ports.now(),
    deleted: Boolean(input.deleted),
  };
  if (!input.deleted && typeof input.deviceDisplayName === "string" && input.deviceDisplayName) {
    content["device_display_name"] = input.deviceDisplayName;
  }
  if (!input.deleted && input.keys) {
    content["keys"] = input.keys;
  }

  for (const destination of destinations) {
    await ports.queueEdu(destination, "m.device_list_update", content);
  }

  return {
    destinations,
    sentCount: destinations.length,
  };
}

export async function publishDeviceListUpdatesForNewlySharedServers(
  input: DeviceListJoinUpdateInput,
  ports: DeviceListJoinUpdatePorts,
): Promise<DeviceListJoinUpdateResult> {
  const discoveredSharedServers = await ports.getSharedRemoteServers(input.userId);
  const currentlySharedServers = [
    ...new Set([...discoveredSharedServers, ...(input.sharedServersAfterJoin ?? [])]),
  ];
  const destinations = getDestinations(ports.localServerName, currentlySharedServers).filter(
    (server) => !input.previouslySharedServers.includes(server),
  );

  if (destinations.length === 0) {
    return {
      destinations: [],
      sentCount: 0,
      deviceCount: 0,
    };
  }

  const devices = await ports.getUserDevices(input.userId);
  const deviceKeys = await Promise.all(
    devices.map(async (device) => ({
      device,
      keys: await ports.getStoredDeviceKeys(input.userId, device.device_id),
    })),
  );
  if (deviceKeys.length === 0) {
    return {
      destinations,
      sentCount: 0,
      deviceCount: 0,
    };
  }

  let sentCount = 0;
  let streamId = ports.now();
  for (const destination of destinations) {
    for (const { device, keys } of deviceKeys) {
      const content: Record<string, unknown> = {
        user_id: input.userId,
        device_id: device.device_id,
        stream_id: streamId,
        deleted: false,
      };
      const deviceDisplayName =
        keys !== null ? getDeviceDisplayName(device, keys) : device.display_name;
      if (typeof deviceDisplayName === "string" && deviceDisplayName.length > 0) {
        content["device_display_name"] = deviceDisplayName;
      }
      if (keys !== null) {
        content["keys"] = keys;
      }

      await ports.queueEdu(destination, "m.device_list_update", content);
      sentCount += 1;
      streamId += 1;
    }
  }

  return {
    destinations,
    sentCount,
    deviceCount: deviceKeys.length,
  };
}
