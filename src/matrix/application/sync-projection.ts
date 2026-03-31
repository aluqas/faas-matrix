import type {
  InvitedRoom,
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

export interface SyncProjectionResult {
  inviteRooms: Record<string, InvitedRoom>;
  knockRooms: Record<string, KnockedRoom>;
  leaveRooms: Record<string, LeftRoom>;
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
    const currentMemberState = roomState.find((event) => isLeaveMembershipEvent(event, query.userId));
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
