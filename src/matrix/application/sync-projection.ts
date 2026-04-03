import type {
  AccountDataEvent,
  InvitedRoom,
  JoinedRoom,
  KnockedRoom,
  LeftRoom,
  MatrixEvent,
  PDU,
  StrippedStateEvent,
} from "../../types";
import type { FilterDefinition, SyncRepository } from "../repositories/interfaces";
import { FORGOTTEN_ROOM_ACCOUNT_DATA_TYPE } from "./room-account-data";
import { projectTypingEphemeral } from "./features/typing/project";
import {
  extractInvitePermissionConfigFromAccountData,
  shouldSuppressInviteInSync,
} from "./features/invite-permissions/policy";

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
  isInitialSync: boolean;
  sinceEventPosition: number;
  sinceDeviceKeyPosition: number;
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

const DEFAULT_SYNC_TIMELINE_EVENT_LIMIT = 100;

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

function isLeaveLikeMembershipEvent(event: PDU | null | undefined, userId: string): event is PDU {
  const membership = (event?.content as { membership?: string } | undefined)?.membership;
  return Boolean(
    event &&
    event.type === "m.room.member" &&
    event.state_key === userId &&
    (membership === "leave" || membership === "ban"),
  );
}

function toStrippedStateSource(
  roomState: PDU[],
  strippedState: StrippedStateEvent[],
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

function applyEventFilterWithoutLimit<T extends EventLike>(
  events: T[],
  filter?: SyncEventFilter,
): T[] {
  if (!filter) {
    return events;
  }

  const { limit: _limit, ...rest } = filter;
  return applyEventFilter(events, rest);
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
  options?: { isIncremental?: boolean },
): Promise<AccountDataEvent[]> {
  return applyEventFilter(
    await repository.getGlobalAccountData(
      userId,
      options?.isIncremental || sincePosition > 0 ? sincePosition : undefined,
    ),
    filter,
  );
}

async function detectTimelineGap(
  repository: SyncRepository,
  timelineEvents: PDU[],
): Promise<{ limited: boolean; trimIndex: number }> {
  if (timelineEvents.length === 0) {
    return { limited: false, trimIndex: 0 };
  }

  const seenTimelineEventIds = new Set<string>();

  for (const [index, event] of timelineEvents.entries()) {
    const previousEventIds = Array.isArray(event.prev_events) ? event.prev_events : [];

    if (
      index > 0 &&
      (previousEventIds.length === 0 ||
        !previousEventIds.some((previousEventId) => seenTimelineEventIds.has(previousEventId)))
    ) {
      return { limited: true, trimIndex: index };
    }

    seenTimelineEventIds.add(event.event_id);
  }

  const firstEvent = timelineEvents[0];
  if (!Array.isArray(firstEvent.prev_events) || firstEvent.prev_events.length === 0) {
    return { limited: false, trimIndex: 0 };
  }

  const previousEvents = await Promise.all(
    firstEvent.prev_events.map((prevEventId) => repository.getEvent(prevEventId)),
  );
  if (previousEvents.some((previousEvent) => previousEvent === null)) {
    return { limited: true, trimIndex: 0 };
  }

  return { limited: false, trimIndex: 0 };
}

export async function projectDeviceLists(
  repository: SyncRepository,
  query: DeviceListProjectionQuery,
): Promise<{ changed: string[]; left: string[] } | undefined> {
  if (query.isInitialSync) {
    return { changed: [query.userId], left: [] };
  }

  const deviceListChanges = await repository.getDeviceListChanges(
    query.userId,
    query.sinceEventPosition,
    query.sinceDeviceKeyPosition,
  );
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
  const currentMembership =
    query.sincePosition > 0 ? await repository.getMembership(query.roomId, query.userId) : null;
  const lazyLoadMembers =
    query.roomFilter?.timeline?.lazy_load_members === true ||
    query.roomFilter?.state?.lazy_load_members === true;
  const roomState =
    query.fullState || query.sincePosition === 0 || lazyLoadMembers
      ? await repository.getRoomState(query.roomId)
      : [];
  let stateEvents: MatrixEvent[] = [];
  let timelineEvents: MatrixEvent[] = [];
  let timelineSourceEvents: PDU[] = [];
  let timelineLimited = false;

  for (const event of events) {
    const clientEvent = toClientEvent(event);
    const timelineIncluded =
      applyEventFilterWithoutLimit([clientEvent], query.roomFilter?.timeline).length > 0;

    if (event.state_key !== undefined && timelineIncluded) {
      stateEvents.push(clientEvent);
    }
    if (timelineIncluded) {
      timelineEvents.push(clientEvent);
      timelineSourceEvents.push(event);
    }
  }

  if (query.fullState || query.sincePosition === 0) {
    for (const event of roomState) {
      const clientEvent = toClientEvent(event);
      if (!stateEvents.find((existing) => existing.event_id === event.event_id)) {
        stateEvents.push(clientEvent);
      }
    }
  }

  if (lazyLoadMembers && roomState.length > 0) {
    const memberUserIds = new Set<string>();
    for (const event of timelineEvents) {
      if (typeof event.sender === "string") {
        memberUserIds.add(event.sender);
      }
    }
    for (const event of stateEvents) {
      if (typeof event.sender === "string") {
        memberUserIds.add(event.sender);
      }
      if (event.type === "m.room.member" && typeof event.state_key === "string") {
        memberUserIds.add(event.state_key);
      }
    }

    for (const event of roomState) {
      if (
        event.type === "m.room.member" &&
        event.state_key !== undefined &&
        memberUserIds.has(event.state_key) &&
        !stateEvents.find((existing) => existing.event_id === event.event_id)
      ) {
        stateEvents.push(toClientEvent(event));
      }
    }
  }

  const filteredTimelineEvents = applyEventFilterWithoutLimit(
    timelineEvents,
    query.roomFilter?.timeline,
  );
  let effectiveTimelineEvents = filteredTimelineEvents;
  const gap = await detectTimelineGap(repository, timelineSourceEvents);
  if (gap.limited) {
    timelineLimited = true;
    if (gap.trimIndex > 0) {
      effectiveTimelineEvents = effectiveTimelineEvents.slice(gap.trimIndex);
    }
  }
  const timelineLimit = query.roomFilter?.timeline?.limit;
  if (typeof timelineLimit === "number" && timelineLimit > 0) {
    timelineLimited = timelineLimited || effectiveTimelineEvents.length > timelineLimit;
    timelineEvents = effectiveTimelineEvents.slice(-timelineLimit);
  } else {
    timelineEvents = effectiveTimelineEvents;
  }
  if (!timelineLimited && events.length >= DEFAULT_SYNC_TIMELINE_EVENT_LIMIT) {
    timelineLimited = true;
  }
  if (
    !timelineLimited &&
    query.sincePosition > 0 &&
    currentMembership?.membership === "join" &&
    typeof currentMembership.streamOrdering === "number" &&
    currentMembership.streamOrdering > query.sincePosition &&
    timelineEvents.length > 0
  ) {
    timelineLimited = true;
  }
  joinedRoom.state!.events = applyEventFilter(stateEvents, query.roomFilter?.state);
  joinedRoom.timeline!.events = timelineEvents;
  joinedRoom.timeline!.limited = timelineLimited;
  joinedRoom.timeline!.prev_batch = query.sincePosition.toString();
  if (lazyLoadMembers) {
    joinedRoom.state_after = {
      events: [...joinedRoom.state!.events],
    };
  }

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
    joinedRoom.ephemeral!.events.push(receipts);
  }

  const unreadSummary = await repository.getUnreadNotificationSummary(query.roomId, query.userId);
  const includeThreadNotifications =
    query.roomFilter?.timeline?.unread_thread_notifications === true;
  joinedRoom.unread_notifications = includeThreadNotifications
    ? unreadSummary.main
    : unreadSummary.room;
  if (includeThreadNotifications && Object.keys(unreadSummary.threads).length > 0) {
    joinedRoom.unread_thread_notifications = unreadSummary.threads;
  }

  joinedRoom.ephemeral!.events.push(
    ...(await projectTypingEphemeral(repository, {
      roomId: query.roomId,
      includeEmpty: query.sincePosition > 0,
      filter: query.roomFilter?.ephemeral,
    })),
  );

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
  const invitePermissionConfig = extractInvitePermissionConfigFromAccountData(
    await repository.getGlobalAccountData(query.userId),
  );
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
      isLeaveLikeMembershipEvent(event, query.userId),
    );
    if (currentMemberState) {
      result.leaveRooms[roomId] = toLeftRoom(currentMemberState);
      continue;
    }

    const membership = await repository.getMembership(roomId, query.userId);
    if (membership?.membership !== "invite") {
      continue;
    }

    const inviteEvent =
      (membership.eventId ? await repository.getEvent(membership.eventId) : null) ??
      roomState.find(
        (event) =>
          event.type === "m.room.member" &&
          event.state_key === query.userId &&
          (event.content as { membership?: string } | undefined)?.membership === "invite",
      ) ??
      null;
    if (inviteEvent && shouldSuppressInviteInSync(invitePermissionConfig, inviteEvent.sender)) {
      continue;
    }

    const inviteStripped = await repository.getInviteStrippedState(roomId);
    const stateSource = toStrippedStateSource(roomState, inviteStripped);
    if (
      inviteEvent &&
      inviteEvent.type === "m.room.member" &&
      inviteEvent.state_key === query.userId &&
      !stateSource.some(
        (event) => event.type === inviteEvent.type && event.state_key === inviteEvent.state_key,
      )
    ) {
      stateSource.push({
        type: inviteEvent.type,
        state_key: inviteEvent.state_key,
        content: inviteEvent.content,
        sender: inviteEvent.sender,
      });
    }

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

  const leaveLikeRoomIds = new Set<string>([
    ...(await repository.getUserRooms(query.userId, "leave")),
    ...(await repository.getUserRooms(query.userId, "ban")),
  ]);
  for (const roomId of leaveLikeRoomIds) {
    if (!shouldIncludeRoom(roomId, query.roomFilter)) {
      continue;
    }

    if (query.sincePosition === 0) {
      const roomAccountData = await repository.getRoomAccountData(query.userId, roomId);
      if (roomAccountData.some((event) => event.type === FORGOTTEN_ROOM_ACCOUNT_DATA_TYPE)) {
        continue;
      }
    }

    let leaveEvent: PDU | undefined;
    if (query.sincePosition > 0) {
      leaveEvent = (await repository.getEventsSince(roomId, query.sincePosition)).find((event) =>
        isLeaveLikeMembershipEvent(event, query.userId),
      );
    }

    if (!leaveEvent) {
      const membership = await repository.getMembership(roomId, query.userId);
      if (membership?.membership === "leave" || membership?.membership === "ban") {
        const event = await repository.getEvent(membership.eventId);
        if (isLeaveLikeMembershipEvent(event, query.userId)) {
          leaveEvent = event;
        } else {
          leaveEvent = (await repository.getRoomState(roomId)).find((stateEvent) =>
            isLeaveLikeMembershipEvent(stateEvent, query.userId),
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
