import type { PresenceEvent, PresenceState, UserId } from "../../../../fatrix-model/types";
import { applyEventFilter } from "../../orchestrators/sync-projection";
import type {
  PresenceProjectionPort,
  PresenceProjectionQuery,
  PresenceProjectionResult,
} from "./contracts";
import {
  findPresenceByUserIds,
  listVisibleUsers as dbListVisibleUsers,
} from "../../../../platform/cloudflare/adapters/repositories/presence-repository";

export async function getPresenceForUsers(
  db: D1Database,
  userIds: UserId[],
  cache?: KVNamespace,
): Promise<
  Record<
    UserId,
    {
      presence: PresenceState;
      status_msg?: string | undefined;
      last_active_ago?: number | undefined;
      currently_active?: boolean | undefined;
    }
  >
> {
  const records = await findPresenceByUserIds(db, userIds, cache);
  return Object.fromEntries(
    Object.entries(records).map(([uid, rec]) => [
      uid,
      {
        presence: rec.presence,
        ...(rec.statusMsg !== undefined ? { status_msg: rec.statusMsg } : {}),
        last_active_ago: rec.lastActiveAgo,
        currently_active: rec.currentlyActive,
      },
    ]),
  );
}

/**
 * Creates a PresenceProjectionPort bound to a D1 database and optional KV cache.
 * Use this to inject presence projection into sync/sliding-sync handlers.
 */
export function createPresenceProjectionPort(
  db: D1Database,
  cache?: KVNamespace,
): PresenceProjectionPort {
  return { projectEvents: (query) => projectPresenceEvents(db, cache, query) };
}

export async function projectPresenceEvents(
  db: D1Database,
  cache: KVNamespace | undefined,
  query: PresenceProjectionQuery,
): Promise<PresenceProjectionResult> {
  const visibleUsers = await dbListVisibleUsers(db, query.userId, query.visibleRoomIds);
  // Always include self so that "set presence → read back via /sync" works even
  // when listVisibleUsers excludes the requesting user from room member candidates.
  const candidates: UserId[] = Array.from(new Set([query.userId, ...visibleUsers]));
  const presenceByUser = await getPresenceForUsers(db, candidates, cache);

  return {
    events: applyEventFilter(
      Object.entries(presenceByUser).map(
        ([sender, content]): PresenceEvent => ({
          type: "m.presence" as const,
          sender: sender as UserId,
          content: {
            presence: content.presence,
            ...(content.status_msg !== undefined ? { status_msg: content.status_msg } : {}),
            ...(content.last_active_ago !== undefined
              ? { last_active_ago: content.last_active_ago }
              : {}),
            ...(content.currently_active !== undefined
              ? { currently_active: content.currently_active }
              : {}),
          },
        }),
      ),
      query.filter,
    ),
  };
}
