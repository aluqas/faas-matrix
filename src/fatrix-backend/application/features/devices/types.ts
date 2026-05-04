export interface DeviceRecord {
  deviceId: string;
  displayName: string | null;
  lastSeenTs: number | null;
  lastSeenIp: string | null;
}
