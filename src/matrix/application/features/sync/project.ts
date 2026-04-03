import { Effect } from "effect";
import type { AppContext } from "../../../../foundation/app-context";
import type { SyncResponse } from "../../../../types";
import { InfraError, type InfraError as InfraErrorType } from "../../domain-error";
import { requireLogContext, withLogContext } from "../../logging";
import type { SyncRepository } from "../../../repositories/interfaces";
import { executePresenceCommand } from "../presence/command";
import { getSharedServersInRoomsWithUserIncludingPartialState } from "../partial-state/shared-servers";
import { assembleSyncResponseEffect } from "./assembler";
import { summarizeSyncResponse, type SyncUserInput } from "./contracts";
import { createEffectPartialStatePort, createEffectSyncQueryPort } from "./effect-adapters";

export function projectSyncResponseEffect(
  appContext: AppContext,
  repository: SyncRepository,
  input: SyncUserInput,
): Effect.Effect<SyncResponse, InfraErrorType> {
  const query = createEffectSyncQueryPort(repository);
  const partialState = createEffectPartialStatePort(
    appContext.capabilities.sql.connection as D1Database,
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
    const requestedPresence = input.setPresence;
    if (requestedPresence) {
      yield* Effect.tryPromise({
        try: () =>
          executePresenceCommand(
            {
              userId: input.userId,
              presence: requestedPresence,
              now: appContext.capabilities.clock.now(),
            },
            {
              localServerName: appContext.capabilities.config.serverName,
              persistPresence: async (presenceInput) => {
                const db = appContext.capabilities.sql.connection as D1Database;
                await db
                  .prepare(`
                    INSERT INTO presence (user_id, presence, status_msg, last_active_ts)
                    VALUES (?, ?, ?, ?)
                    ON CONFLICT (user_id) DO UPDATE SET
                      presence = excluded.presence,
                      status_msg = excluded.status_msg,
                      last_active_ts = excluded.last_active_ts
                  `)
                  .bind(
                    presenceInput.userId,
                    presenceInput.presence,
                    presenceInput.statusMessage || null,
                    presenceInput.now,
                  )
                  .run();

                const cache = appContext.capabilities.kv.cache as KVNamespace | undefined;
                if (cache) {
                  await cache.put(
                    `presence:${presenceInput.userId}`,
                    JSON.stringify({
                      presence: presenceInput.presence,
                      status_msg: presenceInput.statusMessage || null,
                      last_active_ts: presenceInput.now,
                    }),
                    { expirationTtl: 5 * 60 },
                  );
                }
              },
              resolveInterestedServers: async (userId) =>
                getSharedServersInRoomsWithUserIncludingPartialState(
                  appContext.capabilities.sql.connection as D1Database,
                  appContext.capabilities.kv.cache as KVNamespace | undefined,
                  userId,
                ),
              queueEdu: async (destination, content) => {
                await appContext.capabilities.federation?.queueEdu?.(
                  destination,
                  "m.presence",
                  content as unknown as Record<string, unknown>,
                );
              },
              debugEnabled: appContext.profile.name === "complement",
            },
          ),
        catch: (cause) =>
          new InfraError({
            errcode: "M_UNKNOWN",
            message: "Failed to update presence from /sync",
            status: 500,
            cause,
          }),
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
