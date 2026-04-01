import type { MiddlewareHandler } from "hono";
import type { AppEnv, Env, RoomJoinWorkflowParams, RoomJoinWorkflowStatus } from "../../types";
import type { AppContext } from "../../foundation/app-context";
import { createFeatureProfile } from "../../foundation/config/feature-profile";
import type { RuntimeCapabilities } from "../../foundation/runtime-capabilities";
import {
  generateEventId,
  generateOpaqueId,
  generateRoomId,
  formatRoomAlias,
} from "../../utils/ids";
import { createMatrixServiceRegistry, type MatrixServiceRegistry } from "../../matrix/services";
import { getPartialStateJoin } from "../../matrix/application/features/partial-state/tracker";
import {
  CloudflareDeliveryQueue,
  CloudflareDiscoveryService,
  CloudflareFederationRepository,
  CloudflareRemoteKeyCache,
  CloudflareRoomRepository,
  CloudflareSignedTransport,
  CloudflareSyncRepository,
} from "./matrix-repositories";
import { CloudflareIdempotencyStore } from "./idempotency-store";
import { queueFederationEdu } from "../../matrix/application/features/shared/federation-edu-queue";

function createRuntimeCapabilities(
  env: Env,
  defer: (task: Promise<unknown>) => void,
): RuntimeCapabilities {
  const workflowWaitTimeoutMs = 30000;
  return {
    sql: { connection: env.DB },
    kv: {
      sessions: env.SESSIONS,
      cache: env.CACHE,
      accountData: env.ACCOUNT_DATA,
      deviceKeys: env.DEVICE_KEYS,
      crossSigningKeys: env.CROSS_SIGNING_KEYS,
      oneTimeKeys: env.ONE_TIME_KEYS,
    },
    blob: {
      media: env.MEDIA,
    },
    jobs: {
      defer,
    },
    workflow: {
      async createRoomJoin(params: RoomJoinWorkflowParams): Promise<RoomJoinWorkflowStatus> {
        const instance = await env.ROOM_JOIN_WORKFLOW.create({ params });
        const startedAt = Date.now();
        let status = await instance.status();

        while (
          status.status === "queued" ||
          status.status === "running" ||
          status.status === "waiting"
        ) {
          if (params.isRemote) {
            const partialStateJoin = await getPartialStateJoin(
              env.CACHE,
              params.userId,
              params.roomId,
            );
            if (partialStateJoin) {
              break;
            }
          }

          if (Date.now() - startedAt >= workflowWaitTimeoutMs) {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 200));
          status = await instance.status();
        }

        return status as RoomJoinWorkflowStatus;
      },
      async createPushNotification(params: unknown) {
        return env.PUSH_NOTIFICATION_WORKFLOW.create({ params });
      },
    },
    rateLimit: {
      namespace: env.RATE_LIMIT,
    },
    realtime: {
      notifyRoomEvent(roomId: string, eventId: string, eventType: string) {
        void roomId;
        void eventId;
        void eventType;
        return Promise.resolve();
      },
      async setRoomTyping(roomId: string, userId: string, typing: boolean, timeoutMs = 30000) {
        const doId = env.ROOMS.idFromName(roomId);
        const stub = env.ROOMS.get(doId);
        await stub.fetch(
          new Request("https://room/typing", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              user_id: userId,
              typing,
              timeout: timeoutMs,
            }),
          }),
        );
      },
      async setRoomReceipt(
        roomId: string,
        userId: string,
        eventId: string,
        receiptType: string,
        threadId?: string,
        ts?: number,
      ) {
        const doId = env.ROOMS.idFromName(roomId);
        const stub = env.ROOMS.get(doId);
        await stub.fetch(
          new Request("https://room/receipt", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              user_id: userId,
              event_id: eventId,
              receipt_type: receiptType,
              ...(threadId ? { thread_id: threadId } : {}),
              ...(ts !== undefined ? { ts } : {}),
            }),
          }),
        );
      },
      async waitForUserEvents(userId: string, timeoutMs: number) {
        const doId = env.SYNC.idFromName(userId);
        const stub = env.SYNC.get(doId);
        const response = await stub.fetch(
          new Request("http://internal/wait-for-events", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ timeout: timeoutMs }),
          }),
        );
        return response.json() as Promise<{ hasEvents: boolean }>;
      },
    },
    federation: {
      async queueEdu(destination: string, eduType: string, content: Record<string, unknown>) {
        await queueFederationEdu(env, destination, eduType, content);
      },
    },
    metrics: {
      writePoint(metric: string, value: number, tags?: Record<string, string>) {
        if (!env.ANALYTICS) {
          return;
        }
        env.ANALYTICS.writeDataPoint({
          blobs: [metric, JSON.stringify(tags || {})],
          doubles: [value],
          indexes: [metric],
        });
      },
    },
    clock: {
      now: () => Date.now(),
    },
    id: {
      generateRoomId,
      generateEventId,
      generateOpaqueId,
      formatRoomAlias,
    },
    config: {
      serverName: env.SERVER_NAME,
      serverVersion: env.SERVER_VERSION,
    },
  };
}

function createCloudflareAppContext(
  env: Env,
  defer: (task: Promise<unknown>) => void,
): AppContext<MatrixServiceRegistry> {
  const capabilities = createRuntimeCapabilities(env, defer);
  const profile = createFeatureProfile(env.MATRIX_FEATURE_PROFILE);

  const appContext = {
    capabilities,
    profile,
    services: undefined as unknown as MatrixServiceRegistry,
    defer,
  };

  appContext.services = createMatrixServiceRegistry({
    appContext,
    roomRepository: new CloudflareRoomRepository(env),
    syncRepository: new CloudflareSyncRepository(env),
    federationRepository: new CloudflareFederationRepository(env),
    idempotencyStore: new CloudflareIdempotencyStore(env.DB),
    signedTransport: new CloudflareSignedTransport(),
    discoveryService: new CloudflareDiscoveryService(env),
    deliveryQueue: new CloudflareDeliveryQueue(),
    remoteKeyCache: new CloudflareRemoteKeyCache(env),
  });

  return appContext;
}

export function appContextMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const appContext = createCloudflareAppContext(c.env, (task) => c.executionCtx.waitUntil(task));
    c.set("appContext", appContext);
    await next();
  };
}
