import type { AppContext } from "./ports/runtime/app-context";
import { DefaultEventPipeline, type EventPipeline } from "./application/domain/event-pipeline";
import type { FederationRepository, RoomRepository, SyncRepository } from "./ports/repositories";
import { MatrixRoomService } from "./application/orchestrators/room-service";
import { MatrixRoomQueryService } from "./application/room-query-service";
import { MatrixSyncService } from "./application/orchestrators/sync-service";
import { MatrixFederationService } from "./application/legacy/federation-service";
import type { IdempotencyStore } from "../fetherate/runtime/idempotency";
import type { AdminService } from "./application/admin-service";
import { CloudflareBackedAdminService } from "./application/admin-service";
import type {
  DeliveryQueue,
  DiscoveryService,
  RemoteKeyCache,
  SignedTransport,
} from "./application/federation/transactions/contracts";
import type { FederationEduHandlers } from "./application/federation/transactions/edu-ingest";
import type { SyncApplicationPorts } from "./application/features/sync/use-cases/project-sync-response";

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
  federationEduHandlers?: FederationEduHandlers;
  syncApplicationPorts: SyncApplicationPorts;
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
    sync: new MatrixSyncService(
      options.appContext,
      options.syncRepository,
      options.syncApplicationPorts,
    ),
    federation: new MatrixFederationService(
      options.appContext,
      options.federationRepository,
      options.signedTransport,
      options.discoveryService,
      options.deliveryQueue,
      options.remoteKeyCache,
      options.federationEduHandlers,
    ),
    admin: new CloudflareBackedAdminService(options.appContext),
    eventPipeline,
  };
}
