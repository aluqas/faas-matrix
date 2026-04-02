import type { AppContext } from "../../../../foundation/app-context";
import type { SyncResponse } from "../../../../types";
import type { SyncRepository } from "../../../repositories/interfaces";
import { getPartialStateJoin, takePartialStateJoinCompletion } from "../partial-state/tracker";
import { runClientEffect } from "../../effect-runtime";
import { requireLogContext, withLogContext } from "../../logging";
import { shouldIncludeRoom } from "../../sync-projection";
import {
  buildSyncToken,
  parseSyncToken,
  summarizeSyncResponse,
  type SyncAssemblerInput,
} from "./contracts";
import { projectRoomDeltas } from "./room-delta";
import { projectMembershipRoomBuckets } from "./membership-rooms";
import { projectTopLevelSync } from "./top-level";

export interface SyncAssemblerPorts {
  appContext: AppContext;
  repository: SyncRepository;
}

export async function assembleSyncResponse(
  ports: SyncAssemblerPorts,
  input: SyncAssemblerInput,
): Promise<SyncResponse> {
  const logger = withLogContext(
    requireLogContext(
      "sync.assembler",
      {
        component: "sync",
        operation: "assembler",
        user_id: input.userId,
        device_id: input.deviceId ?? undefined,
        debugEnabled: ports.appContext.profile.name === "complement",
      },
      ["user_id"],
    ),
  );
  await runClientEffect(
    logger.debug("sync.assembler.start", {
      has_device_id: Boolean(input.deviceId),
      since: input.since,
      full_state: Boolean(input.fullState),
      has_filter: Boolean(input.filterParam),
      timeout_ms: input.timeout ?? 0,
    }),
  );

  const filter = await ports.repository.loadFilter(input.userId, input.filterParam);
  const cursor = parseSyncToken(input.since);
  const currentPosition = await ports.repository.getLatestStreamPosition();
  const currentDeviceKeyPosition = await ports.repository.getLatestDeviceKeyPosition();
  const partialStateCache = ports.appContext.capabilities.kv.cache as KVNamespace | undefined;

  const response: SyncResponse = {
    next_batch: "",
    rooms: { join: {}, invite: {}, leave: {}, knock: {} },
    presence: { events: [] },
    account_data: { events: [] },
    to_device: { events: [] },
    device_one_time_keys_count: {},
    device_unused_fallback_key_types: [],
  };

  const joinedRoomIds = await ports.repository.getUserRooms(input.userId, "join");
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
    const partialStateJoin = await getPartialStateJoin(partialStateCache, input.userId, roomId);
    if (partialStateJoin && !shouldExposePartialStateRoom()) {
      await runClientEffect(
        logger.debug("sync.assembler.partial_state_hidden", {
          room_id: roomId,
          partial_state_event_id: partialStateJoin.eventId,
        }),
      );
      continue;
    }

    const partialStateCompletion = await takePartialStateJoinCompletion(
      partialStateCache,
      input.userId,
      roomId,
    );
    if (partialStateCompletion) {
      forceFullStateRooms.add(roomId);
    }
    roomIdsForDelta.push(roomId);
  }

  for (const roomId of roomIdsForDelta) {
    const joinedRooms = await projectRoomDeltas(
      { repository: ports.repository },
      {
        userId: input.userId,
        roomIds: [roomId],
        sincePosition: cursor.events,
        fullState: input.fullState || forceFullStateRooms.has(roomId),
        roomFilter: filter?.room,
      },
    );
    Object.assign(response.rooms!.join!, joinedRooms);
  }

  const membershipProjection = await projectMembershipRoomBuckets(
    { repository: ports.repository },
    {
      userId: input.userId,
      sincePosition: cursor.events,
      roomFilter: filter?.room,
      includeLeave: (filter?.room?.include_leave ?? false) || (cursor.events > 0 && !filter),
    },
  );

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

  const topLevel = await projectTopLevelSync(
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
  );

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
    await runClientEffect(
      logger.debug("sync.assembler.long_poll", {
        timeout_ms: timeout,
        since_position: cursor.events,
      }),
    );
    await ports.repository.waitForUserEvents(input.userId, Math.min(timeout, 25000));
    return assembleSyncResponse(ports, {
      ...input,
      timeout: 0,
    });
  }

  response.next_batch = buildSyncToken(
    currentPosition,
    topLevel.currentToDevicePos,
    currentDeviceKeyPosition,
  );

  const summary = summarizeSyncResponse(response);
  await runClientEffect(
    logger.info("sync.assembler.result", {
      joined_room_count: summary.joinedRoomCount,
      invite_room_count: summary.inviteRoomCount,
      leave_room_count: summary.leaveRoomCount,
      knock_room_count: summary.knockRoomCount,
      to_device_count: summary.toDeviceCount,
      account_data_count: summary.accountDataCount,
      presence_count: summary.presenceCount,
      device_list_changed_count: summary.deviceListChangedCount,
      device_list_left_count: summary.deviceListLeftCount,
    }),
  );

  return response;
}
