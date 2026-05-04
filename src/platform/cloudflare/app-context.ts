import type { MiddlewareHandler } from "hono";
import type {
  EventId,
  EventType,
  PDU,
  RoomId,
  RoomJoinWorkflowParams,
  RoomJoinWorkflowStatus,
  UserId,
} from "../../fatrix-model/types";
import type { AppEnv } from "../../fatrix-api/hono-env";
import type { Env } from "./env";
import type { AppContext } from "../../fatrix-backend/ports/runtime/app-context";
import { createFeatureProfile } from "../../fatrix-backend/config/feature-profile";
import type { RuntimeCapabilities } from "../../fatrix-backend/ports/runtime/runtime-capabilities";
import {
  generateEventId,
  generateOpaqueId,
  generateRoomId,
  formatRoomAlias,
} from "../../fatrix-model/utils/ids";
import {
  createMatrixServiceRegistry,
  type MatrixServiceRegistry,
} from "../../fatrix-backend/service-registry";
import { getPartialStateStatus } from "../../fatrix-backend/application/features/partial-state/tracker";
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
import {
  enqueueFederationEdu,
  enqueueFederationPdu,
} from "./adapters/federation/federation-outbound";
import { createFederationTypingIngestPorts } from "./adapters/application-ports/typing/effect-adapters";
import { createFederationReceiptIngestPorts } from "./adapters/application-ports/receipts/effect-adapters";
import { ingestDirectToDeviceEdu } from "./adapters/application-ports/to-device/ingest";
import { createPresenceCommandPortsFromAppContext } from "./adapters/application-ports/presence/effect-adapters";
import { createEffectPartialStatePort } from "./adapters/application-ports/sync/partial-state-port";
import { createSyncTopLevelProjectionPorts } from "./adapters/application-ports/sync/top-level-ports";

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
            const partialStateJoin = await getPartialStateStatus(
              env.CACHE,
              params.userId,
              params.roomId,
            );
            if (partialStateJoin && partialStateJoin.phase !== "complete") {
              break;
            }
          }

          if (Date.now() - startedAt >= workflowWaitTimeoutMs) {
            break;
          }
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 200);
          });
          status = await instance.status();
        }

        return status as RoomJoinWorkflowStatus;
      },
      createPushNotification(params: unknown) {
        return env.PUSH_NOTIFICATION_WORKFLOW.create({ params });
      },
    },
    rateLimit: {
      namespace: env.RATE_LIMIT,
    },
    realtime: {
      notifyRoomEvent(roomId: RoomId, eventId: EventId, eventType: EventType) {
        void roomId;
        void eventId;
        void eventType;
        return Promise.resolve();
      },
      async setRoomTyping(roomId: RoomId, userId: UserId, typing: boolean, timeoutMs = 30000) {
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
        roomId: RoomId,
        userId: UserId,
        eventId: EventId,
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
      async waitForUserEvents(userId: UserId, timeoutMs: number) {
        const doId = env.SYNC.idFromName(userId);
        const stub = env.SYNC.get(doId);
        const response = await stub.fetch(
          new Request("http://internal/wait-for-events", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ timeout: timeoutMs }),
          }),
        );
        return response.json();
      },
    },
    federation: {
      async queueEdu(destination: string, eduType: string, content: Record<string, unknown>) {
        await enqueueFederationEdu(env, destination, eduType, content);
      },
      async queuePdu(destination: string, roomId: RoomId, pdu: PDU) {
        await enqueueFederationPdu(env, destination, roomId, pdu);
      },
    },
    metrics: {
      writePoint(metric: string, value: number, tags?: Record<string, string>) {
        if (!env.ANALYTICS) {
          return;
        }
        env.ANALYTICS.writeDataPoint({
          blobs: [metric, JSON.stringify(tags ?? {})],
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
    syncApplicationPorts: {
      partialState: createEffectPartialStatePort(env.DB, env.CACHE),
      presenceCommand: createPresenceCommandPortsFromAppContext(appContext),
      topLevel: createSyncTopLevelProjectionPorts({
        db: env.DB,
        cache: env.CACHE,
        debugEnabled: profile.name === "complement",
      }),
    },
    signedTransport: new CloudflareSignedTransport(),
    discoveryService: new CloudflareDiscoveryService(env),
    deliveryQueue: new CloudflareDeliveryQueue(),
    remoteKeyCache: new CloudflareRemoteKeyCache(env),
    federationEduHandlers: {
      typing: createFederationTypingIngestPorts({
        db: env.DB,
        realtime: capabilities.realtime,
        cache: env.CACHE,
      }),
      receipts: createFederationReceiptIngestPorts({
        db: env.DB,
        realtime: capabilities.realtime,
        cache: env.CACHE,
      }),
      directToDevice: {
        ingest: (origin, content) => ingestDirectToDeviceEdu(env.DB, origin, content),
      },
    },
  });

  return appContext;
}

export function appContextMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const appContext = createCloudflareAppContext(c.env, (task) => {
      c.executionCtx.waitUntil(task);
    });
    c.set("appContext", appContext);
    await next();
  };
}
