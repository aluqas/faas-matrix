import type { AppContext } from "../../../../foundation/app-context";
import type { SyncResponse } from "../../../../types";
import type { SyncRepository } from "../../../repositories/interfaces";
import { getPartialStateJoin, takePartialStateJoinCompletion } from "../partial-state/tracker";
import { runClientEffect } from "../../effect-runtime";
import { withLogContext } from "../../logging";
import {
  projectDeviceLists,
  projectGlobalAccountData,
  projectJoinedRoom,
  projectMembershipRooms,
  shouldIncludeRoom,
} from "../../sync-projection";
import { projectPresenceEvents } from "../presence/project";
import {
  buildSyncToken,
  parseSyncToken,
  summarizeSyncResponse,
  type SyncUserInput,
} from "./contracts";

export async function projectSyncResponse(
  appContext: AppContext,
  repository: SyncRepository,
  input: SyncUserInput,
): Promise<SyncResponse> {
  const logger = withLogContext({
    component: "sync",
    operation: "project",
    user_id: input.userId,
    device_id: input.deviceId ?? undefined,
    debugEnabled: appContext.profile.name === "complement",
  });
  await runClientEffect(
    logger.debug("sync.project.start", {
      has_device_id: Boolean(input.deviceId),
      since: input.since,
      full_state: Boolean(input.fullState),
      has_filter: Boolean(input.filterParam),
      timeout_ms: input.timeout ?? 0,
    }),
  );
  const filter = await repository.loadFilter(input.userId, input.filterParam);
  const {
    events: sincePosition,
    toDevice: sinceToDevice,
    deviceKeys: sinceDeviceKeys,
  } = parseSyncToken(input.since);
  const currentPosition = await repository.getLatestStreamPosition();
  const currentDeviceKeyPosition = await repository.getLatestDeviceKeyPosition();
  let currentToDevicePos = sinceToDevice;

  const response: SyncResponse = {
    next_batch: "",
    rooms: { join: {}, invite: {}, leave: {}, knock: {} },
    presence: { events: [] },
    account_data: { events: [] },
    to_device: { events: [] },
    device_one_time_keys_count: {},
    device_unused_fallback_key_types: [],
  };
  const partialStateCache = appContext.capabilities.kv.cache as KVNamespace | undefined;

  function shouldExposePartialStateRoom(): boolean {
    return (
      filter?.room?.timeline?.lazy_load_members === true ||
      filter?.room?.state?.lazy_load_members === true
    );
  }

  if (input.deviceId) {
    const toDeviceResult = await repository.getToDeviceMessages(
      input.userId,
      input.deviceId,
      String(sinceToDevice),
    );
    response.to_device!.events = toDeviceResult.events;
    currentToDevicePos = Number.parseInt(toDeviceResult.nextBatch, 10) || sinceToDevice;
    response.device_one_time_keys_count = await repository.getOneTimeKeyCounts(
      input.userId,
      input.deviceId,
    );
    response.device_unused_fallback_key_types = await repository.getUnusedFallbackKeyTypes(
      input.userId,
      input.deviceId,
    );
  }

  response.device_lists = await projectDeviceLists(repository, {
    userId: input.userId,
    isInitialSync: !input.since,
    sinceEventPosition: sincePosition,
    sinceDeviceKeyPosition: sinceDeviceKeys,
  });

  response.account_data!.events = await projectGlobalAccountData(
    repository,
    input.userId,
    sincePosition,
    filter?.account_data,
  );

  const joinedRoomIds = await repository.getUserRooms(input.userId, "join");
  for (const roomId of joinedRoomIds) {
    if (!shouldIncludeRoom(roomId, filter?.room)) {
      continue;
    }

    const partialStateJoin = await getPartialStateJoin(partialStateCache, input.userId, roomId);
    if (partialStateJoin && !shouldExposePartialStateRoom()) {
      await runClientEffect(
        logger.debug("sync.project.partial_state_hidden", {
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

    response.rooms!.join![roomId] = await projectJoinedRoom(repository, {
      userId: input.userId,
      roomId,
      sincePosition,
      fullState: input.fullState || Boolean(partialStateCompletion),
      roomFilter: filter?.room,
    });
  }

  const includeLeave = filter?.room?.include_leave ?? false;
  const membershipProjection = await projectMembershipRooms(repository, {
    userId: input.userId,
    sincePosition,
    roomFilter: filter?.room,
    includeLeave: includeLeave || (sincePosition > 0 && !filter),
  });
  if (Object.keys(membershipProjection.inviteRooms).length > 0) {
    response.rooms!.invite = membershipProjection.inviteRooms;
  } else {
    delete response.rooms!.invite;
  }
  if (Object.keys(membershipProjection.knockRooms).length > 0) {
    response.rooms!.knock = membershipProjection.knockRooms;
  } else {
    delete response.rooms!.knock;
  }
  if (Object.keys(membershipProjection.leaveRooms).length > 0) {
    response.rooms!.leave = membershipProjection.leaveRooms;
    for (const roomId of Object.keys(membershipProjection.leaveRooms)) {
      delete response.rooms!.join?.[roomId];
    }
  } else {
    delete response.rooms!.leave;
  }

  response.presence = await projectPresenceEvents(
    appContext.capabilities.sql.connection as D1Database,
    appContext.capabilities.kv.cache as KVNamespace | undefined,
    {
      userId: input.userId,
      roomIds: joinedRoomIds,
      filter: filter?.presence,
      debugEnabled: appContext.profile.name === "complement",
    },
  );

  const joinedRooms = response.rooms?.join ?? {};
  const inviteRooms = response.rooms?.invite ?? {};
  const leaveRooms = response.rooms?.leave ?? {};
  const knockRooms = response.rooms?.knock ?? {};
  const toDeviceEvents = response.to_device?.events ?? [];
  const accountDataEvents = response.account_data?.events ?? [];
  const presenceEvents = response.presence?.events ?? [];

  const hasRoomChanges = Object.values(joinedRooms).some(
    (room) =>
      (room.timeline?.events.length || 0) > 0 ||
      (room.state?.events.length || 0) > 0 ||
      (room.ephemeral?.events.length || 0) > 0 ||
      (room.account_data?.events.length || 0) > 0,
  );
  const hasInvites = Object.keys(inviteRooms).length > 0;
  const hasLeaves = Object.keys(leaveRooms).length > 0;
  const hasKnocks = Object.keys(knockRooms).length > 0;
  const hasToDevice = toDeviceEvents.length > 0;
  const hasAccountData = accountDataEvents.length > 0;
  const hasPresence = presenceEvents.length > 0;
  const deviceListChangedCount = response.device_lists?.changed?.length ?? 0;
  const deviceListLeftCount = response.device_lists?.left?.length ?? 0;
  const hasDeviceLists = deviceListChangedCount > 0 || deviceListLeftCount > 0;
  const hasChanges =
    hasRoomChanges ||
    hasInvites ||
    hasLeaves ||
    hasKnocks ||
    hasToDevice ||
    hasAccountData ||
    hasPresence ||
    hasDeviceLists;
  const timeout = Math.min(input.timeout || 0, 30000);

  if (!hasChanges && timeout > 0 && sincePosition > 0) {
    await runClientEffect(
      logger.debug("sync.project.long_poll", {
        timeout_ms: timeout,
        since_position: sincePosition,
      }),
    );
    await repository.waitForUserEvents(input.userId, Math.min(timeout, 25000));
    return projectSyncResponse(appContext, repository, {
      ...input,
      timeout: 0,
    });
  }

  response.next_batch = buildSyncToken(
    currentPosition,
    currentToDevicePos,
    currentDeviceKeyPosition,
  );
  const summary = summarizeSyncResponse(response);
  await runClientEffect(
    logger.info("sync.project.result", {
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
