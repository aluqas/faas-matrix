import type { DeviceKeysPayload } from "../../shared/types/client";

export interface DeviceListBroadcastInput {
  userId: string;
  deviceId: string;
  deviceDisplayName?: string;
  keys?: DeviceKeysPayload | null;
  deleted?: boolean;
  sharedServers?: string[];
}

export interface DeviceListBroadcastResult {
  destinations: string[];
  sentCount: number;
}

export interface DeviceListBroadcastPorts {
  localServerName: string;
  now(): number;
  getSharedRemoteServers(userId: string): Promise<string[]>;
  queueEdu(destination: string, eduType: string, content: Record<string, unknown>): Promise<void>;
}

export interface DeviceListJoinUpdateInput {
  userId: string;
  previouslySharedServers: string[];
  sharedServersAfterJoin?: string[];
}

export interface DeviceListJoinUpdateResult {
  destinations: string[];
  sentCount: number;
  deviceCount: number;
}

export interface DeviceListJoinUpdatePorts extends DeviceListBroadcastPorts {
  getUserDevices(userId: string): Promise<Array<{ device_id: string; display_name?: string }>>;
  getStoredDeviceKeys(userId: string, deviceId: string): Promise<DeviceKeysPayload | null>;
}
