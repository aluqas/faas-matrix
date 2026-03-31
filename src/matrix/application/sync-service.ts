import type { AppContext } from "../../foundation/app-context";
import type { JoinedRoom, InvitedRoom, KnockedRoom, LeftRoom, SyncResponse } from "../../types";
import type { SyncRepository } from "../repositories/interfaces";
import { applyEventFilter, projectMembershipRooms, shouldIncludeRoom } from "./sync-projection";

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

    if (sincePosition > 0) {
      const deviceListChanges = await this.repository.getDeviceListChanges(
        input.userId,
        sincePosition,
      );
      if (deviceListChanges.changed.length > 0 || deviceListChanges.left.length > 0) {
        response.device_lists = deviceListChanges;
      }
    } else {
      response.device_lists = { changed: [input.userId], left: [] };
    }

    response.account_data!.events = applyEventFilter(
      await this.repository.getGlobalAccountData(
        input.userId,
        sincePosition > 0 ? sincePosition : undefined,
      ),
      filter?.account_data,
    );

    const joinedRoomIds = await this.repository.getUserRooms(input.userId, "join");
    for (const roomId of joinedRoomIds) {
      if (!shouldIncludeRoom(roomId, filter?.room)) {
        continue;
      }

      const joinedRoom: JoinedRoom = {
        timeline: { events: [], limited: false },
        state: { events: [] },
        ephemeral: { events: [] },
        account_data: { events: [] },
      };

      const events = await this.repository.getEventsSince(roomId, sincePosition);
      let stateEvents: any[] = [];
      let timelineEvents: any[] = [];

      for (const event of events) {
        const clientEvent = {
          type: event.type,
          state_key: event.state_key,
          content: event.content,
          sender: event.sender,
          origin_server_ts: event.origin_server_ts,
          event_id: event.event_id,
          room_id: event.room_id,
          unsigned: event.unsigned,
        };

        if (event.state_key !== undefined) {
          stateEvents.push(clientEvent);
        }
        timelineEvents.push(clientEvent);
      }

      if (input.fullState || sincePosition === 0) {
        const state = await this.repository.getRoomState(roomId);
        for (const event of state) {
          const clientEvent = {
            type: event.type,
            state_key: event.state_key,
            content: event.content,
            sender: event.sender,
            origin_server_ts: event.origin_server_ts,
            event_id: event.event_id,
            room_id: event.room_id,
          };
          if (!stateEvents.find((existing) => existing.event_id === event.event_id)) {
            stateEvents.push(clientEvent);
          }
        }
      }

      joinedRoom.state!.events = applyEventFilter(stateEvents, filter?.room?.state);
      joinedRoom.timeline!.events = applyEventFilter(timelineEvents, filter?.room?.timeline);
      joinedRoom.timeline!.prev_batch = sincePosition.toString();

      joinedRoom.account_data!.events = applyEventFilter(
        await this.repository.getRoomAccountData(
          input.userId,
          roomId,
          sincePosition > 0 ? sincePosition : undefined,
        ),
        filter?.room?.account_data,
      );

      const receipts = await this.repository.getReceiptsForRoom(roomId, input.userId);
      if (Object.keys(receipts.content).length > 0) {
        joinedRoom.ephemeral!.events.push(receipts as any);
      }

      const typingUsers = await this.repository.getTypingUsers(roomId);
      if (typingUsers.length > 0) {
        joinedRoom.ephemeral!.events.push({
          type: "m.typing",
          content: { user_ids: typingUsers },
        } as any);
      }

      joinedRoom.ephemeral!.events = applyEventFilter(
        joinedRoom.ephemeral!.events,
        filter?.room?.ephemeral,
      );

      response.rooms!.join![roomId] = joinedRoom;
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
