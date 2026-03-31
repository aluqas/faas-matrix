import type { AppContext } from "../../foundation/app-context";
import type { JoinedRoom, InvitedRoom, KnockedRoom, LeftRoom, SyncResponse } from "../../types";
import type { SyncRepository } from "../repositories/interfaces";
import {
  projectDeviceLists,
  projectGlobalAccountData,
  projectJoinedRoom,
  projectMembershipRooms,
  shouldIncludeRoom,
} from "./sync-projection";

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

export class MatrixSyncService {
  constructor(
    _appContext: AppContext,
    private readonly repository: SyncRepository,
  ) {
    void _appContext;
  }

  async syncUser(input: SyncUserInput): Promise<SyncResponse> {
    const filter = await this.repository.loadFilter(input.userId, input.filterParam);
    const { events: sincePosition, toDevice: sinceToDevice } = parseSyncToken(input.since);
    const currentPosition = await this.repository.getLatestStreamPosition();
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
      const toDeviceResult = await this.repository.getToDeviceMessages(
        input.userId,
        input.deviceId,
        String(sinceToDevice),
      );
      response.to_device!.events = toDeviceResult.events as any[];
      currentToDevicePos = Number.parseInt(toDeviceResult.nextBatch, 10) || sinceToDevice;
      response.device_one_time_keys_count = await this.repository.getOneTimeKeyCounts(
        input.userId,
        input.deviceId,
      );
      response.device_unused_fallback_key_types = await this.repository.getUnusedFallbackKeyTypes(
        input.userId,
        input.deviceId,
      );
    }

    response.device_lists = await projectDeviceLists(this.repository, {
      userId: input.userId,
      sincePosition,
    });

    response.account_data!.events = await projectGlobalAccountData(
      this.repository,
      input.userId,
      sincePosition,
      filter?.account_data,
    );

    const joinedRoomIds = await this.repository.getUserRooms(input.userId, "join");
    for (const roomId of joinedRoomIds) {
      if (!shouldIncludeRoom(roomId, filter?.room)) {
        continue;
      }

      response.rooms!.join![roomId] = (await projectJoinedRoom(this.repository, {
        userId: input.userId,
        roomId,
        sincePosition,
        fullState: input.fullState,
        roomFilter: filter?.room,
      })) as JoinedRoom;
    }

    const includeLeave = filter?.room?.include_leave ?? false;
    const membershipProjection = await projectMembershipRooms(this.repository, {
      userId: input.userId,
      sincePosition,
      roomFilter: filter?.room,
      includeLeave: includeLeave || (sincePosition > 0 && !filter),
    });
    response.rooms!.invite = membershipProjection.inviteRooms as Record<string, InvitedRoom>;
    response.rooms!.knock = membershipProjection.knockRooms as Record<string, KnockedRoom>;
    response.rooms!.leave = membershipProjection.leaveRooms as Record<string, LeftRoom>;

    const hasRoomChanges = Object.keys(response.rooms!.join!).some((roomId) => {
      const room = response.rooms!.join![roomId];
      return room.timeline!.events.length > 0 || room.state!.events.length > 0;
    });
    const hasInvites = Object.keys(response.rooms!.invite!).length > 0;
    const hasLeaves = Object.keys(response.rooms!.leave!).length > 0;
    const hasToDevice = response.to_device!.events.length > 0;
    const hasAccountData = response.account_data!.events.length > 0;
    const hasKnocks = Object.keys(response.rooms!.knock!).length > 0;
    const hasChanges =
      hasRoomChanges || hasInvites || hasLeaves || hasKnocks || hasToDevice || hasAccountData;
    const timeout = Math.min(input.timeout || 0, 30000);

    if (!hasChanges && timeout > 0 && sincePosition > 0) {
      await this.repository.waitForUserEvents(input.userId, Math.min(timeout, 25000));
      return this.syncUser({
        ...input,
        timeout: 0,
      });
    }

    response.next_batch = buildSyncToken(currentPosition, currentToDevicePos);
    return response;
  }
}
