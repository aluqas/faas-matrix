import type { AppContext } from '../../foundation/app-context';
import type {
  JoinedRoom,
  InvitedRoom,
  LeftRoom,
  SyncResponse,
} from '../../types';
import type { FilterDefinition, SyncRepository } from '../repositories/interfaces';

interface EventFilter {
  types?: string[];
  not_types?: string[];
  senders?: string[];
  not_senders?: string[];
  limit?: number;
}

export interface SyncUserInput {
  userId: string;
  deviceId: string | null;
  since?: string;
  fullState?: boolean;
  filterParam?: string;
  timeout?: number;
}

function applyEventFilter(events: any[], filter?: EventFilter): any[] {
  if (!filter) return events;

  let filtered = events.filter((event) => {
    if (filter.types && filter.types.length > 0) {
      const matches = filter.types.some((pattern) =>
        pattern.endsWith('*') ? event.type.startsWith(pattern.slice(0, -1)) : event.type === pattern
      );
      if (!matches) return false;
    }

    if (filter.not_types && filter.not_types.length > 0) {
      const excluded = filter.not_types.some((pattern) =>
        pattern.endsWith('*') ? event.type.startsWith(pattern.slice(0, -1)) : event.type === pattern
      );
      if (excluded) return false;
    }

    if (filter.senders && filter.senders.length > 0 && !filter.senders.includes(event.sender)) {
      return false;
    }

    if (filter.not_senders && filter.not_senders.length > 0 && filter.not_senders.includes(event.sender)) {
      return false;
    }

    return true;
  });

  if (filter.limit && filter.limit > 0) {
    filtered = filtered.slice(0, filter.limit);
  }

  return filtered;
}

function shouldIncludeRoom(roomId: string, filter?: FilterDefinition['room']): boolean {
  if (!filter) return true;
  if (filter.rooms && filter.rooms.length > 0 && !filter.rooms.includes(roomId)) return false;
  if (filter.not_rooms && filter.not_rooms.length > 0 && filter.not_rooms.includes(roomId)) return false;
  return true;
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
    private readonly repository: SyncRepository
  ) {
    void _appContext;
  }

  async syncUser(input: SyncUserInput): Promise<SyncResponse> {
    const filter = await this.repository.loadFilter(input.userId, input.filterParam);
    const { events: sincePosition, toDevice: sinceToDevice } = parseSyncToken(input.since);
    const currentPosition = await this.repository.getLatestStreamPosition();
    let currentToDevicePos = sinceToDevice;

    const response: SyncResponse = {
      next_batch: '',
      rooms: { join: {}, invite: {}, leave: {} },
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
        String(sinceToDevice)
      );
      response.to_device!.events = toDeviceResult.events as any[];
      currentToDevicePos = Number.parseInt(toDeviceResult.nextBatch, 10) || sinceToDevice;
      response.device_one_time_keys_count = await this.repository.getOneTimeKeyCounts(
        input.userId,
        input.deviceId
      );
      response.device_unused_fallback_key_types = await this.repository.getUnusedFallbackKeyTypes(
        input.userId,
        input.deviceId
      );
    }

    if (sincePosition > 0) {
      const deviceListChanges = await this.repository.getDeviceListChanges(input.userId, sincePosition);
      if (deviceListChanges.changed.length > 0 || deviceListChanges.left.length > 0) {
        response.device_lists = deviceListChanges;
      }
    } else {
      response.device_lists = { changed: [input.userId], left: [] };
    }

    response.account_data!.events = applyEventFilter(
      await this.repository.getGlobalAccountData(
        input.userId,
        sincePosition > 0 ? sincePosition : undefined
      ),
      filter?.account_data
    );

    const joinedRoomIds = await this.repository.getUserRooms(input.userId, 'join');
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
          sincePosition > 0 ? sincePosition : undefined
        ),
        filter?.room?.account_data
      );

      const receipts = await this.repository.getReceiptsForRoom(roomId, input.userId);
      if (Object.keys(receipts.content).length > 0) {
        joinedRoom.ephemeral!.events.push(receipts as any);
      }

      const typingUsers = await this.repository.getTypingUsers(roomId);
      if (typingUsers.length > 0) {
        joinedRoom.ephemeral!.events.push({
          type: 'm.typing',
          content: { user_ids: typingUsers },
        } as any);
      }

      joinedRoom.ephemeral!.events = applyEventFilter(
        joinedRoom.ephemeral!.events,
        filter?.room?.ephemeral
      );

      response.rooms!.join![roomId] = joinedRoom;
    }

    const invitedRoomIds = await this.repository.getUserRooms(input.userId, 'invite');
    for (const roomId of invitedRoomIds) {
      if (!shouldIncludeRoom(roomId, filter?.room)) {
        continue;
      }

      const inviteStripped = await this.repository.getInviteStrippedState(roomId);
      const stateSource = inviteStripped.length > 0
        ? inviteStripped
        : (await this.repository.getRoomState(roomId)).map((event) => ({
            type: event.type,
            state_key: event.state_key!,
            content: event.content,
            sender: event.sender,
          }));
      const strippedState = applyEventFilter(stateSource, filter?.room?.state);

      const invitedRoom: InvitedRoom = {
        invite_state: {
          events: strippedState,
        },
      };

      response.rooms!.invite![roomId] = invitedRoom;
    }

    const includeLeave = filter?.room?.include_leave ?? false;
    if (sincePosition > 0 && (includeLeave || !filter)) {
      const leftRoomIds = await this.repository.getUserRooms(input.userId, 'leave');
      for (const roomId of leftRoomIds) {
        if (!shouldIncludeRoom(roomId, filter?.room)) {
          continue;
        }

        const leaveEvent = (await this.repository.getEventsSince(roomId, sincePosition)).find(
          (event) => event.type === 'm.room.member' && event.state_key === input.userId
        );

        if (!leaveEvent) {
          continue;
        }

        const leftRoom: LeftRoom = {
          timeline: {
            events: [
              {
                type: leaveEvent.type,
                state_key: leaveEvent.state_key,
                content: leaveEvent.content,
                sender: leaveEvent.sender,
                origin_server_ts: leaveEvent.origin_server_ts,
                event_id: leaveEvent.event_id,
                room_id: leaveEvent.room_id,
              },
            ],
          },
        };

        response.rooms!.leave![roomId] = leftRoom;
      }
    }

    const hasRoomChanges = Object.keys(response.rooms!.join!).some((roomId) => {
      const room = response.rooms!.join![roomId];
      return room.timeline!.events.length > 0 || room.state!.events.length > 0;
    });
    const hasInvites = Object.keys(response.rooms!.invite!).length > 0;
    const hasLeaves = Object.keys(response.rooms!.leave!).length > 0;
    const hasToDevice = response.to_device!.events.length > 0;
    const hasAccountData = response.account_data!.events.length > 0;
    const hasChanges = hasRoomChanges || hasInvites || hasLeaves || hasToDevice || hasAccountData;
    const timeout = Math.min(input.timeout || 0, 30000);

    if (!hasChanges && timeout > 0 && sincePosition > 0) {
      await this.repository.waitForUserEvents(input.userId, Math.min(timeout, 25000));
    }

    response.next_batch = buildSyncToken(currentPosition, currentToDevicePos);
    return response;
  }
}
