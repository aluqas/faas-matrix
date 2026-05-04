import { Effect } from "effect";
import type {
  AccountDataEvent,
  DeviceId,
  EventId,
  Membership,
  PDU,
  RoomId,
  StrippedStateEvent,
  ToDeviceEvent,
  UserId,
} from "../../../../../fatrix-model/types";
import type { ConnectionState } from "../../../../../fatrix-model/types/sync";
import type {
  FilterDefinition,
  MembershipRecord,
  ReceiptEvent,
  UnreadNotificationSummary,
} from "../../../../ports/repositories";
import type { PartialStateStatus } from "../../../../../fatrix-model/types/partial-state";
import { InfraError } from "../../../domain-error";

export type { ConnectionState };

export interface SyncQueryPort {
  loadFilter(
    userId: UserId,
    filterParam?: string,
  ): Effect.Effect<FilterDefinition | null, InfraError>;
  getLatestStreamPosition(): Effect.Effect<number, InfraError>;
  getLatestDeviceKeyPosition(): Effect.Effect<number, InfraError>;
  getToDeviceMessages(
    userId: UserId,
    deviceId: DeviceId,
    since: string,
  ): Effect.Effect<{ events: ToDeviceEvent[]; nextBatch: string }, InfraError>;
  getOneTimeKeyCounts(
    userId: UserId,
    deviceId: DeviceId,
  ): Effect.Effect<Record<string, number>, InfraError>;
  getUnusedFallbackKeyTypes(
    userId: UserId,
    deviceId: DeviceId,
  ): Effect.Effect<string[], InfraError>;
  getDeviceListChanges(
    userId: UserId,
    sinceEventPosition: number,
    sinceDeviceKeyPosition: number,
  ): Effect.Effect<{ changed: string[]; left: string[] }, InfraError>;
  getGlobalAccountData(
    userId: UserId,
    since?: number,
  ): Effect.Effect<AccountDataEvent[], InfraError>;
  getRoomAccountData(
    userId: UserId,
    roomId: RoomId,
    since?: number,
  ): Effect.Effect<AccountDataEvent[], InfraError>;
  getUserRooms(userId: UserId, membership?: Membership): Effect.Effect<RoomId[], InfraError>;
  getMembership(roomId: RoomId, userId: UserId): Effect.Effect<MembershipRecord | null, InfraError>;
  getEventsSince(roomId: RoomId, sincePosition: number): Effect.Effect<PDU[], InfraError>;
  getEvent(eventId: EventId): Effect.Effect<PDU | null, InfraError>;
  getRoomState(roomId: RoomId): Effect.Effect<PDU[], InfraError>;
  getInviteStrippedState(roomId: RoomId): Effect.Effect<StrippedStateEvent[], InfraError>;
  getReceiptsForRoom(roomId: RoomId, userId: UserId): Effect.Effect<ReceiptEvent, InfraError>;
  getUnreadNotificationSummary(
    roomId: RoomId,
    userId: UserId,
  ): Effect.Effect<UnreadNotificationSummary, InfraError>;
  getTypingUsers(roomId: RoomId): Effect.Effect<UserId[], InfraError>;
  waitForUserEvents(
    userId: UserId,
    timeoutMs: number,
  ): Effect.Effect<{ hasEvents: boolean }, InfraError>;
}

export interface PartialStatePort {
  getPartialStateStatus(
    userId: string,
    roomId: string,
  ): Effect.Effect<PartialStateStatus | null, InfraError>;
  getPartialStateCompletionStatus(
    userId: string,
    roomId: string,
  ): Effect.Effect<PartialStateStatus | null, InfraError>;
  takePartialStateCompletionStatus(
    userId: string,
    roomId: string,
  ): Effect.Effect<PartialStateStatus | null, InfraError>;
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
