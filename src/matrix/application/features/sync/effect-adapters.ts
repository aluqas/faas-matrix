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
        try: () => repository.getUserRooms(userId, membership),
        catch: (cause) => toInfraError("Failed to load user rooms", cause),
      }),
    getMembership: (roomId, userId) =>
      Effect.tryPromise({
        try: () => repository.getMembership(roomId, userId),
        catch: (cause) => toInfraError("Failed to load room membership", cause),
      }),
    getEventsSince: (roomId, sincePosition) =>
      Effect.tryPromise({
        try: () => repository.getEventsSince(roomId, sincePosition),
        catch: (cause) => toInfraError("Failed to load room events", cause),
      }),
    getEvent: (eventId) =>
      Effect.tryPromise({
        try: () => repository.getEvent(eventId),
        catch: (cause) => toInfraError("Failed to load event", cause),
      }),
    getRoomState: (roomId) =>
      Effect.tryPromise({
        try: () => repository.getRoomState(roomId),
        catch: (cause) => toInfraError("Failed to load room state", cause),
      }),
    getInviteStrippedState: (roomId) =>
      Effect.tryPromise({
        try: () => repository.getInviteStrippedState(roomId),
        catch: (cause) => toInfraError("Failed to load invite stripped state", cause),
      }),
    getReceiptsForRoom: (roomId, userId) =>
      Effect.tryPromise({
        try: () => repository.getReceiptsForRoom(roomId, userId),
        catch: (cause) => toInfraError("Failed to load room receipts", cause),
      }),
    getUnreadNotificationSummary: (roomId, userId) =>
      Effect.tryPromise({
        try: () => repository.getUnreadNotificationSummary(roomId, userId),
        catch: (cause) => toInfraError("Failed to load unread notification summary", cause),
      }),
    getTypingUsers: (roomId) =>
      Effect.tryPromise({
        try: () => repository.getTypingUsers(roomId),
        catch: (cause) => toInfraError("Failed to load typing users", cause),
      }),
    waitForUserEvents: (userId, timeoutMs) =>
      Effect.tryPromise({
        try: () => repository.waitForUserEvents(userId, timeoutMs),
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
        try: async () =>
          (await getPartialStateStatus(cache, userId, roomId)) ??
          getPersistedPartialStateStatus(db, userId, roomId),
        catch: (cause) => toInfraError("Failed to load partial-state status", cause),
      }),
    getPartialStateCompletionStatus: (userId, roomId) =>
      Effect.tryPromise({
        try: async () =>
          (await getPartialStateCompletionStatus(cache, userId, roomId)) ??
          getPersistedPartialStateCompletionStatus(db, userId, roomId),
        catch: (cause) => toInfraError("Failed to load partial-state completion status", cause),
      }),
    takePartialStateCompletionStatus: (userId, roomId) =>
      Effect.tryPromise({
        try: async () =>
          (await consumePartialStateCompletionStatus(cache, userId, roomId)) ??
          takePersistedPartialStateCompletionStatus(db, userId, roomId),
        catch: (cause) => toInfraError("Failed to consume partial-state completion status", cause),
      }),
  };
}
