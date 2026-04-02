import { Effect } from "effect";
import type { AppContext } from "../../../../foundation/app-context";
import type { SyncResponse } from "../../../../types";
import { InfraError } from "../../domain-error";
import { shouldIncludeRoom } from "../../sync-projection";
import type { SyncRepository } from "../../../repositories/interfaces";
import type { PartialStatePort, SyncQueryPort } from "./effect-ports";
import { buildSyncToken, parseSyncToken, type SyncAssemblerInput } from "./contracts";
import { projectMembershipRoomBuckets } from "./membership-rooms";
import { projectRoomDeltas } from "./room-delta";
import { projectTopLevelSync } from "./top-level";

export interface SyncAssemblerPorts {
  appContext: AppContext;
  repository: SyncRepository;
  query: SyncQueryPort;
  partialState: PartialStatePort;
}

function toAssemblerError(message: string, cause: unknown): InfraError {
  return new InfraError({
    errcode: "M_UNKNOWN",
    message,
    status: 500,
    cause,
  });
}

export function assembleSyncResponseEffect(
  ports: SyncAssemblerPorts,
  input: SyncAssemblerInput,
): Effect.Effect<SyncResponse, InfraError> {
  return Effect.gen(function* () {
    const filter = yield* ports.query.loadFilter(input.userId, input.filterParam);
    const cursor = parseSyncToken(input.since);
    const currentPosition = yield* ports.query.getLatestStreamPosition();
    const currentDeviceKeyPosition = yield* ports.query.getLatestDeviceKeyPosition();

    const response: SyncResponse = {
      next_batch: "",
      rooms: { join: {}, invite: {}, leave: {}, knock: {} },
      presence: { events: [] },
      account_data: { events: [] },
      to_device: { events: [] },
      device_one_time_keys_count: {},
      device_unused_fallback_key_types: [],
    };

    const joinedRoomIds = yield* ports.query.getUserRooms(input.userId, "join");
    const visibleJoinedRoomIds = joinedRoomIds.filter((roomId) =>
      shouldIncludeRoom(roomId, filter?.room),
    );

    function shouldExposePartialStateRoom(): boolean {
      return (
        filter?.room?.timeline?.lazy_load_members === true ||
        filter?.room?.state?.lazy_load_members === true
      );
    }

    const roomIdsForDelta: string[] = [];
    const forceFullStateRooms = new Set<string>();
    for (const roomId of visibleJoinedRoomIds) {
      const partialStateJoin = yield* ports.partialState.getPartialStateJoin(input.userId, roomId);
      if (partialStateJoin && !shouldExposePartialStateRoom()) {
        continue;
      }

      const partialStateCompletion = yield* ports.partialState.takePartialStateJoinCompletion(
        input.userId,
        roomId,
      );
      if (partialStateCompletion) {
        forceFullStateRooms.add(roomId);
      }
      roomIdsForDelta.push(roomId);
    }

    for (const roomId of roomIdsForDelta) {
      const joinedRooms = yield* Effect.tryPromise({
        try: () =>
          projectRoomDeltas(
            { repository: ports.repository },
            {
              userId: input.userId,
              roomIds: [roomId],
              sincePosition: cursor.events,
              fullState: input.fullState || forceFullStateRooms.has(roomId),
              roomFilter: filter?.room,
            },
          ),
        catch: (cause) => toAssemblerError("Failed to project joined room delta", cause),
      });
      Object.assign(response.rooms!.join!, joinedRooms);
    }

    const membershipProjection = yield* Effect.tryPromise({
      try: () =>
        projectMembershipRoomBuckets(
          { repository: ports.repository },
          {
            userId: input.userId,
            sincePosition: cursor.events,
            roomFilter: filter?.room,
            includeLeave: (filter?.room?.include_leave ?? false) || (cursor.events > 0 && !filter),
          },
        ),
      catch: (cause) => toAssemblerError("Failed to project membership room buckets", cause),
    });

    response.rooms!.invite = membershipProjection.inviteRooms;
    response.rooms!.knock = membershipProjection.knockRooms;
    response.rooms!.leave = membershipProjection.leaveRooms;
    if (Object.keys(response.rooms!.invite).length === 0) {
      delete response.rooms!.invite;
    }
    if (Object.keys(response.rooms!.knock).length === 0) {
      delete response.rooms!.knock;
    }
    if (Object.keys(response.rooms!.leave).length === 0) {
      delete response.rooms!.leave;
    } else {
      for (const roomId of Object.keys(response.rooms!.leave)) {
        delete response.rooms!.join?.[roomId];
      }
    }

    const topLevel = yield* Effect.tryPromise({
      try: () =>
        projectTopLevelSync(
          { repository: ports.repository, appContext: ports.appContext },
          {
            userId: input.userId,
            deviceId: input.deviceId,
            roomIds: joinedRoomIds,
            sincePosition: cursor.events,
            sinceToDevice: cursor.toDevice,
            sinceDeviceKeys: cursor.deviceKeys,
            ...(input.since ? { sinceToken: input.since } : {}),
            ...(filter ? { filter } : {}),
          },
        ),
      catch: (cause) => toAssemblerError("Failed to project top-level sync payload", cause),
    });

    response.to_device!.events = topLevel.toDeviceEvents;
    response.account_data!.events = topLevel.accountData;
    response.presence = topLevel.presence;
    response.device_one_time_keys_count = topLevel.deviceOneTimeKeysCount;
    response.device_unused_fallback_key_types = topLevel.deviceUnusedFallbackKeyTypes;
    if (topLevel.deviceLists) {
      response.device_lists = topLevel.deviceLists;
    }

    const joinedRooms = response.rooms?.join ?? {};
    const inviteRooms = response.rooms?.invite ?? {};
    const leaveRooms = response.rooms?.leave ?? {};
    const knockRooms = response.rooms?.knock ?? {};
    const hasRoomChanges = Object.values(joinedRooms).some(
      (room) =>
        (room.timeline?.events.length || 0) > 0 ||
        (room.state?.events.length || 0) > 0 ||
        (room.ephemeral?.events.length || 0) > 0 ||
        (room.account_data?.events.length || 0) > 0,
    );
    const hasChanges =
      hasRoomChanges ||
      Object.keys(inviteRooms).length > 0 ||
      Object.keys(leaveRooms).length > 0 ||
      Object.keys(knockRooms).length > 0 ||
      topLevel.toDeviceEvents.length > 0 ||
      topLevel.accountData.length > 0 ||
      topLevel.presence.events.length > 0 ||
      (topLevel.deviceLists?.changed?.length ?? 0) > 0 ||
      (topLevel.deviceLists?.left?.length ?? 0) > 0;

    const timeout = Math.min(input.timeout || 0, 30000);
    if (!hasChanges && timeout > 0 && cursor.events > 0) {
      yield* ports.query.waitForUserEvents(input.userId, Math.min(timeout, 25000));
      return yield* assembleSyncResponseEffect(ports, {
        ...input,
        timeout: 0,
      });
    }

    response.next_batch = buildSyncToken(
      currentPosition,
      topLevel.currentToDevicePos,
      currentDeviceKeyPosition,
    );

    return response;
  });
}
