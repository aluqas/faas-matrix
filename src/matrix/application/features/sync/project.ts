import type { AppContext } from "../../../../foundation/app-context";
import type { SyncResponse } from "../../../../types";
import type { SyncRepository } from "../../../repositories/interfaces";
import {
  projectDeviceLists,
  projectGlobalAccountData,
  projectJoinedRoom,
  projectMembershipRooms,
  shouldIncludeRoom,
} from "../../sync-projection";
import { projectPresenceEvents } from "../presence/project";

export interface SyncUserInput {
  userId: string;
  deviceId: string | null;
  since?: string;
  fullState?: boolean;
  filterParam?: string;
  timeout?: number;
}

export function parseSyncToken(token: string | undefined): { events: number; toDevice: number } {
  if (!token) {
    return { events: 0, toDevice: 0 };
  }

  const match = token.match(/^s(\d+)_td(\d+)$/);
  if (match) {
    return {
      events: Number.parseInt(match[1], 10),
      toDevice: Number.parseInt(match[2], 10),
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

export async function projectSyncResponse(
  appContext: AppContext,
  repository: SyncRepository,
  input: SyncUserInput,
): Promise<SyncResponse> {
  const filter = await repository.loadFilter(input.userId, input.filterParam);
  const { events: sincePosition, toDevice: sinceToDevice } = parseSyncToken(input.since);
  const currentPosition = await repository.getLatestStreamPosition();
  let currentToDevicePos = sinceToDevice;

  const response: SyncResponse = {
    next_batch: "",
    rooms: { join: {}, invite: {}, leave: {}, knock: {} },
    presence: { events: [] },
    account_data: { events: [] },
    to_device: { events: [] },
    device_one_time_keys_count: {},
    device_unused_fallback_key_types: [],
  };

  if (input.deviceId) {
    const toDeviceResult = await repository.getToDeviceMessages(
      input.userId,
      input.deviceId,
      String(sinceToDevice),
    );
    response.to_device!.events = toDeviceResult.events as any[];
    currentToDevicePos = Number.parseInt(toDeviceResult.nextBatch, 10) || sinceToDevice;
    response.device_one_time_keys_count = await repository.getOneTimeKeyCounts(
      input.userId,
      input.deviceId,
    );
    response.device_unused_fallback_key_types = await repository.getUnusedFallbackKeyTypes(
      input.userId,
      input.deviceId,
    );
  }

  response.device_lists = await projectDeviceLists(repository, {
    userId: input.userId,
    sincePosition,
  });

  response.account_data!.events = await projectGlobalAccountData(
    repository,
    input.userId,
    sincePosition,
    filter?.account_data,
  );

  const joinedRoomIds = await repository.getUserRooms(input.userId, "join");
  for (const roomId of joinedRoomIds) {
    if (!shouldIncludeRoom(roomId, filter?.room)) {
      continue;
    }

    response.rooms!.join![roomId] = await projectJoinedRoom(repository, {
      userId: input.userId,
      roomId,
      sincePosition,
      fullState: input.fullState,
      roomFilter: filter?.room,
    });
  }

  const includeLeave = filter?.room?.include_leave ?? false;
  const membershipProjection = await projectMembershipRooms(repository, {
    userId: input.userId,
    sincePosition,
    roomFilter: filter?.room,
    includeLeave: includeLeave || (sincePosition > 0 && !filter),
  });
  response.rooms!.invite = membershipProjection.inviteRooms;
  response.rooms!.knock = membershipProjection.knockRooms;
  response.rooms!.leave = membershipProjection.leaveRooms;

  response.presence = await projectPresenceEvents(
    appContext.capabilities.sql.connection as D1Database,
    appContext.capabilities.kv.cache as KVNamespace | undefined,
    {
      userId: input.userId,
      roomIds: joinedRoomIds,
      filter: filter?.presence,
    },
  );

  const hasRoomChanges = Object.values(response.rooms!.join!).some(
    (room) =>
      (room.timeline?.events.length || 0) > 0 ||
      (room.state?.events.length || 0) > 0 ||
      (room.ephemeral?.events.length || 0) > 0 ||
      (room.account_data?.events.length || 0) > 0,
  );
  const hasInvites = Object.keys(response.rooms!.invite!).length > 0;
  const hasLeaves = Object.keys(response.rooms!.leave!).length > 0;
  const hasKnocks = Object.keys(response.rooms!.knock!).length > 0;
  const hasToDevice = response.to_device!.events.length > 0;
  const hasAccountData = response.account_data!.events.length > 0;
  const hasPresence = response.presence!.events.length > 0;
  const deviceListChangedCount = response.device_lists?.changed?.length ?? 0;
  const deviceListLeftCount = response.device_lists?.left?.length ?? 0;
  const hasDeviceLists = deviceListChangedCount > 0 || deviceListLeftCount > 0;
  const hasChanges =
    hasRoomChanges ||
    hasInvites ||
    hasLeaves ||
    hasKnocks ||
    hasToDevice ||
    hasAccountData ||
    hasPresence ||
    hasDeviceLists;
  const timeout = Math.min(input.timeout || 0, 30000);

  if (!hasChanges && timeout > 0 && sincePosition > 0) {
    await repository.waitForUserEvents(input.userId, Math.min(timeout, 25000));
    return projectSyncResponse(appContext, repository, {
      ...input,
      timeout: 0,
    });
  }

  response.next_batch = buildSyncToken(currentPosition, currentToDevicePos);
  return response;
}
