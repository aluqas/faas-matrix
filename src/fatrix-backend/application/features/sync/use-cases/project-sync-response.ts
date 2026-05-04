import { Effect } from "effect";
import type { AppContext } from "../../../../ports/runtime/app-context";
import type { SyncResponse } from "../../../../../fatrix-model/types";
import { type InfraError as InfraErrorType } from "../../../domain-error";
import { requireLogContext, withLogContext } from "../../../logging";
import type { SyncRepository } from "../../../../ports/repositories";
import { setPresenceStatusEffect } from "../../presence/command";
import type { PresenceCommandEffectPorts } from "../../presence/command";
import { assembleSyncResponseEffect } from "../projectors/assembler";
import type { TopLevelSyncPorts } from "../projectors/top-level";
import { summarizeSyncResponse, type SyncUserInput } from "../types/contracts";
import { createEffectSyncQueryPort } from "../queries/effect-sync-query-port";
import type { PartialStatePort } from "../ports/effect-ports";

export interface SyncApplicationPorts {
  partialState: PartialStatePort;
  presenceCommand: PresenceCommandEffectPorts;
  topLevel: Omit<TopLevelSyncPorts, "repository">;
}

export function projectSyncResponseEffect(
  appContext: AppContext,
  repository: SyncRepository,
  applicationPorts: SyncApplicationPorts,
  input: SyncUserInput,
): Effect.Effect<SyncResponse, InfraErrorType> {
  const query = createEffectSyncQueryPort(repository);
  const logger = withLogContext(
    requireLogContext(
      "sync.project",
      {
        component: "sync",
        operation: "project",
        user_id: input.userId,
        device_id: input.deviceId ?? undefined,
        debugEnabled: appContext.profile.name === "complement",
      },
      ["user_id"],
    ),
  );

  return Effect.gen(function* () {
    const requestedPresence = input.setPresence;
    if (requestedPresence) {
      yield* setPresenceStatusEffect(applicationPorts.presenceCommand, {
        userId: input.userId,
        presence: requestedPresence,
        now: appContext.capabilities.clock.now(),
      });
    }

    yield* logger.debug("sync.assembler.start", {
      has_device_id: Boolean(input.deviceId),
      since: input.since,
      full_state: Boolean(input.fullState),
      has_filter: Boolean(input.filterParam),
      timeout_ms: input.timeout ?? 0,
      set_presence: input.setPresence,
    });

    const response = yield* assembleSyncResponseEffect(
      {
        repository,
        query,
        partialState: applicationPorts.partialState,
        topLevel: applicationPorts.topLevel,
      },
      input,
    );

    const summary = summarizeSyncResponse(response);
    yield* logger.info("sync.assembler.result", {
      joined_room_count: summary.joinedRoomCount,
      invite_room_count: summary.inviteRoomCount,
      leave_room_count: summary.leaveRoomCount,
      knock_room_count: summary.knockRoomCount,
      to_device_count: summary.toDeviceCount,
      account_data_count: summary.accountDataCount,
      presence_count: summary.presenceCount,
      device_list_changed_count: summary.deviceListChangedCount,
      device_list_left_count: summary.deviceListLeftCount,
    });

    return response;
  });
}
