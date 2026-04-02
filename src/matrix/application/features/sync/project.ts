import { Effect } from "effect";
import type { AppContext } from "../../../../foundation/app-context";
import type { SyncResponse } from "../../../../types";
import type { InfraError } from "../../domain-error";
import { requireLogContext, withLogContext } from "../../logging";
import type { SyncRepository } from "../../../repositories/interfaces";
import { assembleSyncResponseEffect } from "./assembler";
import { summarizeSyncResponse, type SyncUserInput } from "./contracts";
import { createEffectPartialStatePort, createEffectSyncQueryPort } from "./effect-adapters";

export function projectSyncResponseEffect(
  appContext: AppContext,
  repository: SyncRepository,
  input: SyncUserInput,
): Effect.Effect<SyncResponse, InfraError> {
  const query = createEffectSyncQueryPort(repository);
  const partialState = createEffectPartialStatePort(
    appContext.capabilities.kv.cache as KVNamespace | undefined,
  );
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
    yield* logger.debug("sync.assembler.start", {
      has_device_id: Boolean(input.deviceId),
      since: input.since,
      full_state: Boolean(input.fullState),
      has_filter: Boolean(input.filterParam),
      timeout_ms: input.timeout ?? 0,
    });

    const response = yield* assembleSyncResponseEffect(
      { appContext, repository, query, partialState },
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
