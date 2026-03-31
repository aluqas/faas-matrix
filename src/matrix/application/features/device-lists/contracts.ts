import type { DeviceKeysPayload } from "../../../../api/keys-contracts";

export interface DeviceListJoinUpdateInput {
  userId: string;
  previouslySharedServers: string[];
}

export interface DeviceListJoinUpdateResult {
  destinations: string[];
  sentCount: number;
  deviceCount: number;
}

export interface DeviceListJoinUpdatePorts {
  localServerName: string;
  now(): number;
  getSharedRemoteServers(userId: string): Promise<string[]>;
  getUserDevices(userId: string): Promise<Array<{ device_id: string; display_name?: string }>>;
  getStoredDeviceKeys(userId: string, deviceId: string): Promise<DeviceKeysPayload | null>;
  queueEdu(destination: string, eduType: string, content: Record<string, unknown>): Promise<void>;
}
