import type { DeviceRecord } from "./types";

export function encodeDevice(device: DeviceRecord) {
  return {
    device_id: device.deviceId,
    display_name: device.displayName ?? undefined,
    last_seen_ts: device.lastSeenTs ?? undefined,
    last_seen_ip: device.lastSeenIp ?? undefined,
  };
}

export function encodeDeviceListResponse(devices: DeviceRecord[]) {
  return {
    devices: devices.map((device) => encodeDevice(device)),
  };
}

export function encodePasswordUiaResponse(session: string, error?: string) {
  return {
    flows: [{ stages: ["m.login.password"] }],
    params: {},
    session,
    ...(error
      ? {
          errcode: "M_FORBIDDEN" as const,
          error,
        }
      : {}),
  };
}

export function encodeEmptyDeviceResponse(): Record<string, never> {
  return {};
}
