import type { EventId, RoomId } from "../../../../types/matrix";
import type { ConnectionState } from "./effect-ports";

export interface SlidingSyncRoomInclusionInput {
  isInitialRoom: boolean;
  timelineEventCount: number;
  notificationCountChanged: boolean;
  fullyReadChanged: boolean;
  firstTimeRead: boolean;
  explicitSubscription?: boolean;
}

export function shouldIncludeSlidingSyncRoom(input: SlidingSyncRoomInclusionInput): boolean {
  if (input.explicitSubscription) {
    return true;
  }

  return (
    input.isInitialRoom ||
    input.timelineEventCount > 0 ||
    input.notificationCountChanged ||
    input.fullyReadChanged ||
    input.firstTimeRead
  );
}

export function didSlidingSyncListChange(
  previousListState: ConnectionState["listStates"][string] | undefined,
  roomIds: string[],
  count: number,
): boolean {
  return (
    !previousListState ||
    previousListState.count !== count ||
    JSON.stringify(previousListState.roomIds) !== JSON.stringify(roomIds)
  );
}

export function readMarkerChanged(
  previousFullyRead: EventId | null | undefined,
  currentFullyRead: EventId | null,
): boolean {
  return currentFullyRead !== null && currentFullyRead !== (previousFullyRead ?? null);
}

export function firstTimeRead(
  state: ConnectionState,
  roomId: RoomId,
  notificationCount: number,
): boolean {
  return notificationCount === 0 && !state.roomSentAsRead?.[roomId];
}

export function trackSlidingSyncRoomReadState(
  state: ConnectionState,
  roomId: RoomId,
  notificationCount: number,
  fullyReadEventId: EventId,
): void {
  state.roomNotificationCounts = state.roomNotificationCounts ?? {};
  state.roomNotificationCounts[roomId] = notificationCount;
  state.roomFullyReadMarkers = state.roomFullyReadMarkers ?? {};
  state.roomFullyReadMarkers[roomId] = fullyReadEventId;
  state.roomSentAsRead = state.roomSentAsRead ?? {};

  if (notificationCount === 0) {
    state.roomSentAsRead[roomId] = true;
    return;
  }

  delete state.roomSentAsRead[roomId];
}
