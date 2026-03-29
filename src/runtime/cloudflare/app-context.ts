import type { MiddlewareHandler } from 'hono';
import type { AppEnv, Env } from '../../types';
import type { AppContext } from '../../foundation/app-context';
import { createFeatureProfile } from '../../foundation/config/feature-profile';
import type { RuntimeCapabilities } from '../../foundation/runtime-capabilities';
import { generateEventId, generateOpaqueId, generateRoomId, formatRoomAlias } from '../../utils/ids';
import { createMatrixServiceRegistry, type MatrixServiceRegistry } from '../../matrix/services';
import {
  CloudflareDeliveryQueue,
  CloudflareDiscoveryService,
  CloudflareFederationRepository,
  CloudflareRemoteKeyCache,
  CloudflareRoomRepository,
  CloudflareSignedTransport,
  CloudflareSyncRepository,
} from './matrix-repositories';
import { CloudflareIdempotencyStore } from './idempotency-store';

function createRuntimeCapabilities(env: Env, defer: (task: Promise<unknown>) => void): RuntimeCapabilities {
  const workflowWaitTimeoutMs = env.MATRIX_FEATURE_PROFILE === 'complement' ? 30000 : 15000;
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
      async createRoomJoin(params: unknown) {
        const instance = await env.ROOM_JOIN_WORKFLOW.create({ params });
        const startedAt = Date.now();
        let status = await instance.status();

        while (
          status.status === 'queued' ||
          status.status === 'running' ||
          status.status === 'waiting'
        ) {
          if (Date.now() - startedAt >= workflowWaitTimeoutMs) {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 200));
          status = await instance.status();
        }

        return status;
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
      async waitForUserEvents(userId: string, timeoutMs: number) {
        const doId = env.SYNC.idFromName(userId);
        const stub = env.SYNC.get(doId);
        const response = await stub.fetch(
          new Request('http://internal/wait-for-events', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ timeout: timeoutMs }),
          })
        );
        return response.json() as Promise<{ hasEvents: boolean }>;
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
  defer: (task: Promise<unknown>) => void
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
    c.set('appContext', appContext);
    await next();
  };
}
