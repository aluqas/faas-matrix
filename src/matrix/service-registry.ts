import type { AppContext } from "../shared/runtime/app-context";
import { DefaultEventPipeline, type EventPipeline } from "./domain/event-pipeline";
import type {
  FederationRepository,
  RoomRepository,
  SyncRepository,
} from "../infra/repositories/interfaces";
import { MatrixRoomService } from "./application/orchestrators/room-service";
import { MatrixRoomQueryService } from "./application/room-query-service";
import { MatrixSyncService } from "./application/orchestrators/sync-service";
import { MatrixFederationService } from "./application/legacy/federation-service";
import type { IdempotencyStore } from "../shared/runtime/idempotency";
import type { AdminService } from "./application/admin-service";
import { CloudflareBackedAdminService } from "./application/admin-service";
import type {
  DeliveryQueue,
  DiscoveryService,
  RemoteKeyCache,
  SignedTransport,
} from "../features/federation-core/contracts";

export interface MatrixServiceRegistry {
  rooms: MatrixRoomService;
  roomQueries: MatrixRoomQueryService;
  sync: MatrixSyncService;
  federation: MatrixFederationService;
  admin: AdminService;
  eventPipeline: EventPipeline;
}

export interface CreateMatrixServiceRegistryOptions {
  appContext: AppContext;
  roomRepository: RoomRepository;
  syncRepository: SyncRepository;
  federationRepository: FederationRepository;
  idempotencyStore: IdempotencyStore<Record<string, unknown>>;
  signedTransport: SignedTransport;
  discoveryService: DiscoveryService;
  deliveryQueue: DeliveryQueue;
  remoteKeyCache: RemoteKeyCache<{ keyId: string; key: string }>;
}

export function createMatrixServiceRegistry(
  options: CreateMatrixServiceRegistryOptions,
): MatrixServiceRegistry {
  const eventPipeline = new DefaultEventPipeline();

  return {
    rooms: new MatrixRoomService(
      options.appContext,
      options.roomRepository,
      eventPipeline,
      options.idempotencyStore,
    ),
    roomQueries: new MatrixRoomQueryService(options.appContext),
    sync: new MatrixSyncService(options.appContext, options.syncRepository),
    federation: new MatrixFederationService(
      options.appContext,
      options.federationRepository,
      options.signedTransport,
      options.discoveryService,
      options.deliveryQueue,
      options.remoteKeyCache,
    ),
    admin: new CloudflareBackedAdminService(options.appContext),
    eventPipeline,
  };
}
