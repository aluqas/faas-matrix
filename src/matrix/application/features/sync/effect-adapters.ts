import { Effect } from "effect";
import type { SyncRepository } from "../../../repositories/interfaces";
import {
  getPersistedPartialStateCompletionStatus,
  getPersistedPartialStateStatus,
  takePersistedPartialStateCompletionStatus,
} from "../partial-state/shared-servers";
import {
  consumePartialStateCompletionStatus,
  getPartialStateCompletionStatus,
  getPartialStateStatus,
} from "../partial-state/tracker";
import { toEventId, toRoomId, toUserId } from "../../../../utils/ids";
import type { PartialStatePort, SyncQueryPort } from "./effect-ports";
import { toInfraError } from "./effect-ports";

export function createEffectSyncQueryPort(repository: SyncRepository): SyncQueryPort {
  return {
    loadFilter: (userId, filterParam) =>
      Effect.tryPromise({
        try: () => repository.loadFilter(userId, filterParam),
        catch: (cause) => toInfraError("Failed to load sync filter", cause),
      }),
    getLatestStreamPosition: () =>
      Effect.tryPromise({
        try: () => repository.getLatestStreamPosition(),
        catch: (cause) => toInfraError("Failed to load latest stream position", cause),
      }),
    getLatestDeviceKeyPosition: () =>
      Effect.tryPromise({
        try: () => repository.getLatestDeviceKeyPosition(),
        catch: (cause) => toInfraError("Failed to load latest device key position", cause),
      }),
    getToDeviceMessages: (userId, deviceId, since) =>
      Effect.tryPromise({
        try: () => repository.getToDeviceMessages(userId, deviceId, since),
        catch: (cause) => toInfraError("Failed to load to-device messages", cause),
      }),
    getOneTimeKeyCounts: (userId, deviceId) =>
      Effect.tryPromise({
        try: () => repository.getOneTimeKeyCounts(userId, deviceId),
        catch: (cause) => toInfraError("Failed to load one-time key counts", cause),
      }),
    getUnusedFallbackKeyTypes: (userId, deviceId) =>
      Effect.tryPromise({
        try: () => repository.getUnusedFallbackKeyTypes(userId, deviceId),
        catch: (cause) => toInfraError("Failed to load fallback key types", cause),
      }),
    getDeviceListChanges: (userId, sinceEventPosition, sinceDeviceKeyPosition) =>
      Effect.tryPromise({
        try: () =>
          repository.getDeviceListChanges(userId, sinceEventPosition, sinceDeviceKeyPosition),
        catch: (cause) => toInfraError("Failed to load device list changes", cause),
      }),
    getGlobalAccountData: (userId, since) =>
      Effect.tryPromise({
        try: () => repository.getGlobalAccountData(userId, since),
        catch: (cause) => toInfraError("Failed to load global account data", cause),
      }),
    getRoomAccountData: (userId, roomId, since) =>
      Effect.tryPromise({
        try: () => repository.getRoomAccountData(userId, roomId, since),
        catch: (cause) => toInfraError("Failed to load room account data", cause),
      }),
    getUserRooms: (userId, membership) =>
      Effect.tryPromise({
        try: () => repository.getUserRooms(toUserId(userId)!, membership),
        catch: (cause) => toInfraError("Failed to load user rooms", cause),
      }),
    getMembership: (roomId, userId) =>
      Effect.tryPromise({
        try: () => repository.getMembership(toRoomId(roomId)!, toUserId(userId)!),
        catch: (cause) => toInfraError("Failed to load room membership", cause),
      }),
    getEventsSince: (roomId, sincePosition) =>
      Effect.tryPromise({
        try: () => repository.getEventsSince(toRoomId(roomId)!, sincePosition),
        catch: (cause) => toInfraError("Failed to load room events", cause),
      }),
    getEvent: (eventId) =>
      Effect.tryPromise({
        try: () => repository.getEvent(toEventId(eventId)!),
        catch: (cause) => toInfraError("Failed to load event", cause),
      }),
    getRoomState: (roomId) =>
      Effect.tryPromise({
        try: () => repository.getRoomState(toRoomId(roomId)!),
        catch: (cause) => toInfraError("Failed to load room state", cause),
      }),
    getInviteStrippedState: (roomId) =>
      Effect.tryPromise({
        try: () => repository.getInviteStrippedState(toRoomId(roomId)!),
        catch: (cause) => toInfraError("Failed to load invite stripped state", cause),
      }),
    getReceiptsForRoom: (roomId, userId) =>
      Effect.tryPromise({
        try: () => repository.getReceiptsForRoom(toRoomId(roomId)!, toUserId(userId)!),
        catch: (cause) => toInfraError("Failed to load room receipts", cause),
      }),
    getUnreadNotificationSummary: (roomId, userId) =>
      Effect.tryPromise({
        try: () => repository.getUnreadNotificationSummary(toRoomId(roomId)!, toUserId(userId)!),
        catch: (cause) => toInfraError("Failed to load unread notification summary", cause),
      }),
    getTypingUsers: (roomId) =>
      Effect.tryPromise({
        try: () => repository.getTypingUsers(toRoomId(roomId)!),
        catch: (cause) => toInfraError("Failed to load typing users", cause),
      }),
    waitForUserEvents: (userId, timeoutMs) =>
      Effect.tryPromise({
        try: () => repository.waitForUserEvents(toUserId(userId)!, timeoutMs),
        catch: (cause) => toInfraError("Failed to wait for user events", cause),
      }),
  };
}

export function createEffectPartialStatePort(
  db: D1Database,
  cache: KVNamespace | undefined,
): PartialStatePort {
  return {
    getPartialStateStatus: (userId, roomId) =>
      Effect.tryPromise({
        try: async () => {
          const typedUserId = toUserId(userId);
          const typedRoomId = toRoomId(roomId);
          if (!typedUserId || !typedRoomId) {
            return null;
          }
          return (
            (await getPartialStateStatus(cache, typedUserId, typedRoomId)) ??
            getPersistedPartialStateStatus(db, typedUserId, typedRoomId)
          );
        },
        catch: (cause) => toInfraError("Failed to load partial-state status", cause),
      }),
    getPartialStateCompletionStatus: (userId, roomId) =>
      Effect.tryPromise({
        try: async () => {
          const typedUserId = toUserId(userId);
          const typedRoomId = toRoomId(roomId);
          if (!typedUserId || !typedRoomId) {
            return null;
          }
          return (
            (await getPartialStateCompletionStatus(cache, typedUserId, typedRoomId)) ??
            getPersistedPartialStateCompletionStatus(db, typedUserId, typedRoomId)
          );
        },
        catch: (cause) => toInfraError("Failed to load partial-state completion status", cause),
      }),
    takePartialStateCompletionStatus: (userId, roomId) =>
      Effect.tryPromise({
        try: async () => {
          const typedUserId = toUserId(userId);
          const typedRoomId = toRoomId(roomId);
          if (!typedUserId || !typedRoomId) {
            return null;
          }
          return (
            (await consumePartialStateCompletionStatus(cache, typedUserId, typedRoomId)) ??
            takePersistedPartialStateCompletionStatus(db, typedUserId, typedRoomId)
          );
        },
        catch: (cause) => toInfraError("Failed to consume partial-state completion status", cause),
      }),
  };
}
