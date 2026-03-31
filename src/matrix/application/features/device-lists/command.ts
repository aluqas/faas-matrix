import type { DeviceKeysPayload } from "../../../../api/keys-contracts";
import type {
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

export async function publishDeviceListUpdatesForNewlySharedServers(
  input: DeviceListJoinUpdateInput,
  ports: DeviceListJoinUpdatePorts,
): Promise<DeviceListJoinUpdateResult> {
  const currentlySharedServers = await ports.getSharedRemoteServers(input.userId);
  const destinations = [...new Set(currentlySharedServers)]
    .filter((server) => server !== ports.localServerName)
    .filter((server) => !input.previouslySharedServers.includes(server));

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
