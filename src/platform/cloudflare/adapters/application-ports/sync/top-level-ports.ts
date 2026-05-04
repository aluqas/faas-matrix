import type { UserId } from "../../../../../fatrix-model/types";
import { getUserPushRules } from "../../../../../fatrix-backend/application/features/push/rules";
import { createPresenceProjectionPort } from "../../../../../fatrix-backend/application/features/presence/project";
import type { TopLevelSyncPorts } from "../../../../../fatrix-backend/application/features/sync/projectors/top-level";

export function createSyncTopLevelProjectionPorts(input: {
  db: D1Database;
  cache?: KVNamespace;
  debugEnabled?: boolean;
}): Omit<TopLevelSyncPorts, "repository"> {
  const presence = createPresenceProjectionPort(input.db, input.cache);

  return {
    pushRules: {
      getUserPushRules: (userId: UserId) => getUserPushRules(input.db, userId),
    },
    presence: {
      projectEvents: (query) =>
        presence.projectEvents({
          ...query,
          ...(input.debugEnabled !== undefined ? { debugEnabled: input.debugEnabled } : {}),
        }),
    },
  };
}
