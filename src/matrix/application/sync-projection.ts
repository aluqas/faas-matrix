import type {
  InvitedRoom,
  JoinedRoom,
  KnockedRoom,
  LeftRoom,
  MatrixEvent,
  PDU,
  StrippedStateEvent,
} from "../../types";
import type { FilterDefinition, SyncRepository } from "../repositories/interfaces";

export interface SyncEventFilter {
  types?: string[];
  not_types?: string[];
  senders?: string[];
  not_senders?: string[];
  limit?: number;
}

export interface SyncProjectionQuery {
  userId: string;
  sincePosition: number;
  roomFilter?: FilterDefinition["room"];
  includeLeave: boolean;
}

export interface DeviceListProjectionQuery {
  userId: string;
  sincePosition: number;
}

export interface SyncProjectionResult {
  inviteRooms: Record<string, InvitedRoom>;
  knockRooms: Record<string, KnockedRoom>;
  leaveRooms: Record<string, LeftRoom>;
}

export interface JoinedRoomProjectionQuery {
  userId: string;
  roomId: string;
  sincePosition: number;
  fullState?: boolean;
  roomFilter?: FilterDefinition["room"];
}

type EventLike = {
  type: string;
  sender?: string;
};

function toClientEvent(event: PDU): MatrixEvent {
  return {
    type: event.type,
    state_key: event.state_key,
    content: event.content,
    sender: event.sender,
    origin_server_ts: event.origin_server_ts,
    event_id: event.event_id,
    room_id: event.room_id,
    unsigned: event.unsigned,
  };
}

function toLeftRoom(event: PDU): LeftRoom {
  return {
    timeline: {
      events: [toClientEvent(event)],
    },
  };
}

function isLeaveMembershipEvent(event: PDU | null | undefined, userId: string): event is PDU {
  return Boolean(
    event &&
    event.type === "m.room.member" &&
    event.state_key === userId &&
    (event.content as { membership?: string } | undefined)?.membership === "leave",
  );
}

function toStrippedStateSource(
  roomState: PDU[],
  strippedState: Array<{ type: string; state_key: string; content: any; sender: string }>,
): StrippedStateEvent[] {
  if (strippedState.length > 0) {
    return strippedState;
  }

  return roomState
    .filter((event): event is PDU & { state_key: string } => event.state_key !== undefined)
    .map((event) => ({
      type: event.type,
      state_key: event.state_key,
      content: event.content,
      sender: event.sender,
    }));
}

export function applyEventFilter<T extends EventLike>(events: T[], filter?: SyncEventFilter): T[] {
  if (!filter) return events;

  let filtered = events.filter((event) => {
    if (filter.types && filter.types.length > 0) {
      const matches = filter.types.some((pattern) =>
        pattern.endsWith("*")
          ? event.type.startsWith(pattern.slice(0, -1))
          : event.type === pattern,
      );
      if (!matches) return false;
    }

    if (filter.not_types && filter.not_types.length > 0) {
      const excluded = filter.not_types.some((pattern) =>
        pattern.endsWith("*")
          ? event.type.startsWith(pattern.slice(0, -1))
          : event.type === pattern,
      );
      if (excluded) return false;
    }

    if (
      filter.senders &&
      filter.senders.length > 0 &&
      typeof event.sender === "string" &&
      !filter.senders.includes(event.sender)
    ) {
      return false;
    }

    if (
      filter.not_senders &&
      filter.not_senders.length > 0 &&
      typeof event.sender === "string" &&
      filter.not_senders.includes(event.sender)
    ) {
      return false;
    }

    return true;
  });

  if (filter.limit && filter.limit > 0) {
    filtered = filtered.slice(0, filter.limit);
  }

  return filtered;
}

export function shouldIncludeRoom(roomId: string, filter?: FilterDefinition["room"]): boolean {
  if (!filter) return true;
  if (filter.rooms && filter.rooms.length > 0 && !filter.rooms.includes(roomId)) return false;
  if (filter.not_rooms && filter.not_rooms.length > 0 && filter.not_rooms.includes(roomId)) {
    return false;
  }
  return true;
}

export async function projectGlobalAccountData(
  repository: SyncRepository,
  userId: string,
  sincePosition: number,
  filter?: SyncEventFilter,
): Promise<any[]> {
  return applyEventFilter(
    await repository.getGlobalAccountData(userId, sincePosition > 0 ? sincePosition : undefined),
    filter,
  );
}

export async function projectDeviceLists(
  repository: SyncRepository,
  query: DeviceListProjectionQuery,
): Promise<{ changed: string[]; left: string[] } | undefined> {
  if (query.sincePosition <= 0) {
    return { changed: [query.userId], left: [] };
  }

  const deviceListChanges = await repository.getDeviceListChanges(query.userId, query.sincePosition);
  if (deviceListChanges.changed.length > 0 || deviceListChanges.left.length > 0) {
    return deviceListChanges;
  }

  return undefined;
}

export async function projectJoinedRoom(
  repository: SyncRepository,
  query: JoinedRoomProjectionQuery,
): Promise<JoinedRoom> {
  const joinedRoom: JoinedRoom = {
    timeline: { events: [], limited: false },
    state: { events: [] },
    ephemeral: { events: [] },
    account_data: { events: [] },
  };

  const events = await repository.getEventsSince(query.roomId, query.sincePosition);
  let stateEvents: MatrixEvent[] = [];
  let timelineEvents: MatrixEvent[] = [];

  for (const event of events) {
    const clientEvent = toClientEvent(event);

    if (event.state_key !== undefined) {
      stateEvents.push(clientEvent);
    }
    timelineEvents.push(clientEvent);
  }

  if (query.fullState || query.sincePosition === 0) {
    const state = await repository.getRoomState(query.roomId);
    for (const event of state) {
      const clientEvent = toClientEvent(event);
      if (!stateEvents.find((existing) => existing.event_id === event.event_id)) {
        stateEvents.push(clientEvent);
      }
    }
  }

  joinedRoom.state!.events = applyEventFilter(stateEvents, query.roomFilter?.state);
  joinedRoom.timeline!.events = applyEventFilter(timelineEvents, query.roomFilter?.timeline);
  joinedRoom.timeline!.prev_batch = query.sincePosition.toString();

  joinedRoom.account_data!.events = applyEventFilter(
    await repository.getRoomAccountData(
      query.userId,
      query.roomId,
      query.sincePosition > 0 ? query.sincePosition : undefined,
    ),
    query.roomFilter?.account_data,
  );

  const receipts = await repository.getReceiptsForRoom(query.roomId, query.userId);
  if (Object.keys(receipts.content).length > 0) {
    joinedRoom.ephemeral!.events.push(receipts as any);
  }

  const typingUsers = await repository.getTypingUsers(query.roomId);
  if (typingUsers.length > 0) {
    joinedRoom.ephemeral!.events.push({
      type: "m.typing",
      content: { user_ids: typingUsers },
    } as any);
  }

  joinedRoom.ephemeral!.events = applyEventFilter(
    joinedRoom.ephemeral!.events,
    query.roomFilter?.ephemeral,
  );

  return joinedRoom;
}

export async function projectMembershipRooms(
  repository: SyncRepository,
  query: SyncProjectionQuery,
): Promise<SyncProjectionResult> {
  const result: SyncProjectionResult = {
    inviteRooms: {},
    knockRooms: {},
    leaveRooms: {},
  };

  const invitedRoomIds = await repository.getUserRooms(query.userId, "invite");
  for (const roomId of invitedRoomIds) {
    if (!shouldIncludeRoom(roomId, query.roomFilter)) {
      continue;
    }

    const roomState = await repository.getRoomState(roomId);
    const currentMemberState = roomState.find((event) =>
      isLeaveMembershipEvent(event, query.userId),
    );
    if (currentMemberState) {
      result.leaveRooms[roomId] = toLeftRoom(currentMemberState);
      continue;
    }

    const membership = await repository.getMembership(roomId, query.userId);
    if (membership?.membership !== "invite") {
      continue;
    }

    const inviteStripped = await repository.getInviteStrippedState(roomId);
    const stateSource = toStrippedStateSource(roomState, inviteStripped);
    result.inviteRooms[roomId] = {
      invite_state: {
        events: applyEventFilter(stateSource, query.roomFilter?.state),
      },
    };
  }

  const knockedRoomIds = await repository.getUserRooms(query.userId, "knock");
  for (const roomId of knockedRoomIds) {
    if (!shouldIncludeRoom(roomId, query.roomFilter)) {
      continue;
    }

    const membership = await repository.getMembership(roomId, query.userId);
    if (membership?.membership !== "knock") {
      continue;
    }

    const roomState = await repository.getRoomState(roomId);
    const stripped = await repository.getInviteStrippedState(roomId);
    const stateSource = toStrippedStateSource(roomState, stripped);
    const knockEvent = await repository.getEvent(membership.eventId);
    if (
      knockEvent &&
      knockEvent.type === "m.room.member" &&
      knockEvent.state_key === query.userId &&
      !stateSource.some(
        (event) => event.type === knockEvent.type && event.state_key === knockEvent.state_key,
      )
    ) {
      stateSource.push({
        type: knockEvent.type,
        state_key: knockEvent.state_key,
        content: knockEvent.content,
        sender: knockEvent.sender,
      });
    }

    result.knockRooms[roomId] = {
      knock_state: {
        events: applyEventFilter(stateSource, query.roomFilter?.state),
      },
    };
  }

  if (!query.includeLeave) {
    return result;
  }

  const leftRoomIds = await repository.getUserRooms(query.userId, "leave");
  for (const roomId of leftRoomIds) {
    if (!shouldIncludeRoom(roomId, query.roomFilter)) {
      continue;
    }

    let leaveEvent: PDU | undefined;
    if (query.sincePosition > 0) {
      leaveEvent = (await repository.getEventsSince(roomId, query.sincePosition)).find((event) =>
        isLeaveMembershipEvent(event, query.userId),
      );
    }

    if (!leaveEvent) {
      const membership = await repository.getMembership(roomId, query.userId);
      if (membership?.membership === "leave") {
        const event = await repository.getEvent(membership.eventId);
        if (isLeaveMembershipEvent(event, query.userId)) {
          leaveEvent = event;
        } else {
          leaveEvent = (await repository.getRoomState(roomId)).find((stateEvent) =>
            isLeaveMembershipEvent(stateEvent, query.userId),
          );
        }
      }
    }

    if (!leaveEvent) {
      continue;
    }

    result.leaveRooms[roomId] = toLeftRoom(leaveEvent);
  }

  return result;
}
