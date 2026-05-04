import type {
  EventId,
  EventType,
  PDU,
  RoomId,
  RoomJoinWorkflowParams,
  RoomJoinWorkflowStatus,
  UserId,
} from "../../../fatrix-model/types";

export interface SqlCapability<TConnection = unknown> {
  connection: TConnection;
}

export interface KeyValueCapability<TNamespace = unknown> {
  sessions?: TNamespace;
  cache?: TNamespace;
  accountData?: TNamespace;
  deviceKeys?: TNamespace;
  crossSigningKeys?: TNamespace;
  oneTimeKeys?: TNamespace;
}

export interface BlobCapability<TBucket = unknown> {
  media?: TBucket;
}

export interface JobsCapability {
  defer(task: Promise<unknown>): void;
}

export interface WorkflowCapability {
  createRoomJoin(params: RoomJoinWorkflowParams): Promise<RoomJoinWorkflowStatus>;
  createPushNotification(params: unknown): Promise<unknown>;
}

export interface RateLimitCapability<TNamespace = unknown> {
  namespace?: TNamespace;
}

export interface RealtimeCapability {
  notifyRoomEvent(roomId: RoomId, eventId: EventId, eventType: EventType): Promise<void>;
  setRoomTyping?(
    roomId: RoomId,
    userId: UserId,
    typing: boolean,
    timeoutMs?: number,
  ): Promise<void>;
  setRoomReceipt?(
    roomId: RoomId,
    userId: UserId,
    eventId: EventId,
    receiptType: string,
    threadId?: string,
    ts?: number,
  ): Promise<void>;
  waitForUserEvents(userId: UserId, timeoutMs: number): Promise<{ hasEvents: boolean }>;
}

export interface FederationCapability {
  queueEdu?(destination: string, eduType: string, content: Record<string, unknown>): Promise<void>;
  queuePdu?(destination: string, roomId: RoomId, pdu: PDU): Promise<void>;
}

export interface MetricsCapability {
  writePoint?(metric: string, value: number, tags?: Record<string, string>): void;
}

export interface ClockCapability {
  now(): number;
}

export interface IdCapability {
  generateRoomId(serverName: string): Promise<string>;
  generateEventId(serverName: string, roomVersion?: string): Promise<string>;
  generateOpaqueId(length?: number): Promise<string>;
  formatRoomAlias(localpart: string, serverName: string): string;
}

export interface RuntimeConfigCapability {
  serverName: string;
  serverVersion: string;
}

export interface RuntimeCapabilities<
  TSql = unknown,
  TKv = unknown,
  TBlob = unknown,
  TRateLimit = unknown,
> {
  sql: SqlCapability<TSql>;
  kv: KeyValueCapability<TKv>;
  blob: BlobCapability<TBlob>;
  jobs: JobsCapability;
  workflow: WorkflowCapability;
  rateLimit: RateLimitCapability<TRateLimit>;
  realtime: RealtimeCapability;
  federation?: FederationCapability;
  metrics: MetricsCapability;
  clock: ClockCapability;
  id: IdCapability;
  config: RuntimeConfigCapability;
}
