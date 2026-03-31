import type { SyncResponse } from "../../../../types";

export interface SyncUserInput {
  userId: string;
  deviceId: string | null;
  since?: string;
  fullState?: boolean;
  filterParam?: string;
  timeout?: number;
}

export interface SyncTokenPosition {
  events: number;
  toDevice: number;
}

export interface SyncProjectionSummary {
  joinedRoomCount: number;
  inviteRoomCount: number;
  leaveRoomCount: number;
  knockRoomCount: number;
  toDeviceCount: number;
  accountDataCount: number;
  presenceCount: number;
  deviceListChangedCount: number;
  deviceListLeftCount: number;
}

export function parseSyncToken(token: string | undefined): SyncTokenPosition {
  if (!token) {
    return { events: 0, toDevice: 0 };
  }

  const match = token.match(/^s(\d+)_td(\d+)$/);
  if (match) {
    return {
      events: Number.parseInt(match[1] ?? "0", 10),
      toDevice: Number.parseInt(match[2] ?? "0", 10),
    };
  }

  const fallback = Number.parseInt(token, 10);
  if (!Number.isNaN(fallback)) {
    return { events: fallback, toDevice: fallback };
  }

  return { events: 0, toDevice: 0 };
}

export function buildSyncToken(eventsPos: number, toDevicePos: number): string {
  return `s${eventsPos}_td${toDevicePos}`;
}

export function summarizeSyncResponse(response: SyncResponse): SyncProjectionSummary {
  return {
    joinedRoomCount: Object.keys(response.rooms?.join ?? {}).length,
    inviteRoomCount: Object.keys(response.rooms?.invite ?? {}).length,
    leaveRoomCount: Object.keys(response.rooms?.leave ?? {}).length,
    knockRoomCount: Object.keys(response.rooms?.knock ?? {}).length,
    toDeviceCount: response.to_device?.events.length ?? 0,
    accountDataCount: response.account_data?.events.length ?? 0,
    presenceCount: response.presence?.events.length ?? 0,
    deviceListChangedCount: response.device_lists?.changed?.length ?? 0,
    deviceListLeftCount: response.device_lists?.left?.length ?? 0,
  };
}
