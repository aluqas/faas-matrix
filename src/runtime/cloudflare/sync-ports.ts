import { Effect } from "effect";
import type { Env } from "../../types";
import { CloudflareSyncRepository } from "./matrix-repositories";
import type {
  ConnectionState,
  PartialStatePort,
  SlidingSyncStatePort,
  SyncQueryPort,
} from "../../matrix/application/features/sync/effect-ports";
import { toInfraError } from "../../matrix/application/features/sync/effect-ports";
import {
  createEffectPartialStatePort,
  createEffectSyncQueryPort,
} from "../../matrix/application/features/sync/effect-adapters";

export function createCloudflareSyncQueryPort(env: Env): SyncQueryPort {
  return createEffectSyncQueryPort(new CloudflareSyncRepository(env));
}

export function createCloudflarePartialStatePort(cache: KVNamespace | undefined): PartialStatePort {
  return createEffectPartialStatePort(cache);
}

export function createCloudflareSlidingSyncStatePort(
  syncDO: DurableObjectNamespace,
): SlidingSyncStatePort {
  return {
    getConnectionState: (userId, connId) =>
      Effect.tryPromise({
        try: async () => {
          const doId = syncDO.idFromName(userId);
          const stub = syncDO.get(doId);
          const response = await stub.fetch(
            new URL(`http://internal/sliding-sync/state?conn_id=${encodeURIComponent(connId)}`),
            { method: "GET" },
          );

          if (!response.ok) {
            const errorText = await response.text().catch(() => "unknown error");
            throw new Error(`DO fetch failed: ${response.status} - ${errorText}`);
          }

          return (await response.json()) as ConnectionState | null;
        },
        catch: (cause) => toInfraError("Failed to load sliding sync connection state", cause, 503),
      }),
    saveConnectionState: (userId, connId, state) =>
      Effect.tryPromise({
        try: async () => {
          const doId = syncDO.idFromName(userId);
          const stub = syncDO.get(doId);
          const response = await stub.fetch(
            new URL(`http://internal/sliding-sync/state?conn_id=${encodeURIComponent(connId)}`),
            {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(state),
            },
          );

          if (!response.ok) {
            const errorText = await response.text().catch(() => "unknown error");
            throw new Error(`DO save failed: ${response.status} - ${errorText}`);
          }
        },
        catch: (cause) => toInfraError("Failed to save sliding sync connection state", cause),
      }),
    waitForUserEvents: (userId, timeoutMs) =>
      Effect.tryPromise({
        try: async () => {
          const doId = syncDO.idFromName(userId);
          const stub = syncDO.get(doId);
          const response = await stub.fetch(
            new Request("http://internal/wait-for-events", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ timeout: timeoutMs }),
            }),
          );
          return response.json() as Promise<{ hasEvents: boolean }>;
        },
        catch: (cause) => toInfraError("Failed to wait for sliding sync events", cause),
      }),
  };
}
