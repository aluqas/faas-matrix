import { Effect } from "effect";
import type {
  AccountDataEvent,
  Membership,
  PDU,
  StrippedStateEvent,
  ToDeviceEvent,
} from "../../../../types";
import type {
  FilterDefinition,
  MembershipRecord,
  ReceiptEvent,
  UnreadNotificationSummary,
} from "../../../repositories/interfaces";
import type { PartialStateJoinMarker } from "../partial-state/tracker";
import { InfraError } from "../../domain-error";

export interface ConnectionState {
  userId: string;
  pos: number;
  lastAccess: number;
  roomStates: Record<
    string,
    {
      lastStreamOrdering: number;
      sentState: boolean;
    }
  >;
  listStates: Record<
    string,
    {
      roomIds: string[];
      count: number;
    }
  >;
  roomNotificationCounts?: Record<string, number>;
  roomFullyReadMarkers?: Record<string, string>;
  initialSyncComplete?: boolean;
  roomSentAsRead?: Record<string, boolean>;
}

export interface SyncQueryPort {
  loadFilter(
    userId: string,
    filterParam?: string,
  ): Effect.Effect<FilterDefinition | null, InfraError>;
  getLatestStreamPosition(): Effect.Effect<number, InfraError>;
  getLatestDeviceKeyPosition(): Effect.Effect<number, InfraError>;
  getToDeviceMessages(
    userId: string,
    deviceId: string,
    since: string,
  ): Effect.Effect<{ events: ToDeviceEvent[]; nextBatch: string }, InfraError>;
  getOneTimeKeyCounts(
    userId: string,
    deviceId: string,
  ): Effect.Effect<Record<string, number>, InfraError>;
  getUnusedFallbackKeyTypes(userId: string, deviceId: string): Effect.Effect<string[], InfraError>;
  getDeviceListChanges(
    userId: string,
    sinceEventPosition: number,
    sinceDeviceKeyPosition: number,
  ): Effect.Effect<{ changed: string[]; left: string[] }, InfraError>;
  getGlobalAccountData(
    userId: string,
    since?: number,
  ): Effect.Effect<AccountDataEvent[], InfraError>;
  getRoomAccountData(
    userId: string,
    roomId: string,
    since?: number,
  ): Effect.Effect<AccountDataEvent[], InfraError>;
  getUserRooms(userId: string, membership?: Membership): Effect.Effect<string[], InfraError>;
  getMembership(roomId: string, userId: string): Effect.Effect<MembershipRecord | null, InfraError>;
  getEventsSince(roomId: string, sincePosition: number): Effect.Effect<PDU[], InfraError>;
  getEvent(eventId: string): Effect.Effect<PDU | null, InfraError>;
  getRoomState(roomId: string): Effect.Effect<PDU[], InfraError>;
  getInviteStrippedState(roomId: string): Effect.Effect<StrippedStateEvent[], InfraError>;
  getReceiptsForRoom(roomId: string, userId: string): Effect.Effect<ReceiptEvent, InfraError>;
  getUnreadNotificationSummary(
    roomId: string,
    userId: string,
  ): Effect.Effect<UnreadNotificationSummary, InfraError>;
  getTypingUsers(roomId: string): Effect.Effect<string[], InfraError>;
  waitForUserEvents(
    userId: string,
    timeoutMs: number,
  ): Effect.Effect<{ hasEvents: boolean }, InfraError>;
}

export interface PartialStatePort {
  getPartialStateJoin(
    userId: string,
    roomId: string,
  ): Effect.Effect<PartialStateJoinMarker | null, InfraError>;
  takePartialStateJoinCompletion(
    userId: string,
    roomId: string,
  ): Effect.Effect<PartialStateJoinMarker | null, InfraError>;
}

export interface SlidingSyncStatePort {
  getConnectionState(
    userId: string,
    connId: string,
  ): Effect.Effect<ConnectionState | null, InfraError>;
  saveConnectionState(
    userId: string,
    connId: string,
    state: ConnectionState,
  ): Effect.Effect<void, InfraError>;
  waitForUserEvents(
    userId: string,
    timeoutMs: number,
  ): Effect.Effect<{ hasEvents: boolean }, InfraError>;
}

export function toInfraError(message: string, cause: unknown, status = 500): InfraError {
  return new InfraError({
    errcode: "M_UNKNOWN",
    message,
    status,
    cause,
  });
}
