import { Effect } from "effect";
import type { PDU } from "../../../fatrix-model/types";
import type { PublicRoomSummary } from "../../../fatrix-model/types/client";
import type { MissingEventsQuery, TimestampDirection } from "../../../fatrix-model/types/events";
import {
  EventQueryRepository,
  type SpaceChildEdge,
} from "../../../platform/cloudflare/adapters/repositories/event-query-repository";
import { InfraError } from "../domain-error";
import { fromInfraPromise } from "../effect/infra-effect";

export type { MissingEventsQuery, SpaceChildEdge, TimestampDirection };

export interface EventQueryRepositoryPort {
  getVisibleEventForUser(
    db: D1Database,
    roomId: string,
    eventId: string,
    userId: string,
  ): Promise<PDU | null>;
  roomExists(db: D1Database, roomId: string): Promise<boolean>;
  getMissingEvents(db: D1Database, query: MissingEventsQuery): Promise<PDU[]>;
  findClosestEventByTimestamp(
    db: D1Database,
    roomId: string,
    ts: number,
    dir: TimestampDirection,
  ): Promise<{ event_id: string; origin_server_ts: number } | null>;
  getSpaceChildEdges(db: D1Database, roomId: string): Promise<SpaceChildEdge[]>;
  getRoomPublicInfo(db: D1Database, roomId: string): Promise<PublicRoomSummary | null>;
  isRoomVisibleToUser(db: D1Database, roomId: string, userId: string): Promise<boolean>;
}

export function normalizeOffsetToken(from?: string | null): number {
  if (!from || !from.startsWith("offset_")) {
    return 0;
  }

  const parsed = Number.parseInt(from.slice("offset_".length), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function selectSpaceChildren(
  edges: SpaceChildEdge[],
  options: { suggestedOnly: boolean; limit: number; offset: number },
): { children: SpaceChildEdge[]; hasMore: boolean } {
  const filtered = edges.filter((edge) => {
    const via = edge.content.via;
    if (!Array.isArray(via) || via.length === 0) {
      return false;
    }

    if (options.suggestedOnly && edge.content.suggested !== true) {
      return false;
    }

    return true;
  });

  return {
    children: filtered.slice(options.offset, options.offset + options.limit),
    hasMore: filtered.length > options.offset + options.limit,
  };
}

export class EventQueryService {
  constructor(private readonly repository: EventQueryRepositoryPort = new EventQueryRepository()) {}

  getVisibleEventForUser(
    db: D1Database,
    roomId: string,
    eventId: string,
    userId: string,
  ): Promise<PDU | null> {
    return this.repository.getVisibleEventForUser(db, roomId, eventId, userId);
  }

  getVisibleEventForUserEffect(
    db: D1Database,
    roomId: string,
    eventId: string,
    userId: string,
  ): Effect.Effect<PDU | null, InfraError> {
    return fromInfraPromise(
      () => this.repository.getVisibleEventForUser(db, roomId, eventId, userId),
      "Failed to load visible event",
    );
  }

  roomExists(db: D1Database, roomId: string): Promise<boolean> {
    return this.repository.roomExists(db, roomId);
  }

  roomExistsEffect(db: D1Database, roomId: string): Effect.Effect<boolean, InfraError> {
    return fromInfraPromise(
      () => this.repository.roomExists(db, roomId),
      "Failed to check room existence",
    );
  }

  getMissingEvents(db: D1Database, query: MissingEventsQuery): Promise<PDU[]> {
    return this.repository.getMissingEvents(db, query);
  }

  getMissingEventsEffect(
    db: D1Database,
    query: MissingEventsQuery,
  ): Effect.Effect<PDU[], InfraError> {
    return fromInfraPromise(
      () => this.repository.getMissingEvents(db, query),
      "Failed to load missing events",
    );
  }

  findClosestEventByTimestamp(
    db: D1Database,
    roomId: string,
    ts: number,
    dir: TimestampDirection,
  ): Promise<{ event_id: string; origin_server_ts: number } | null> {
    return this.repository.findClosestEventByTimestamp(db, roomId, ts, dir);
  }

  findClosestEventByTimestampEffect(
    db: D1Database,
    roomId: string,
    ts: number,
    dir: TimestampDirection,
  ): Effect.Effect<{ event_id: string; origin_server_ts: number } | null, InfraError> {
    return fromInfraPromise(
      () => this.repository.findClosestEventByTimestamp(db, roomId, ts, dir),
      "Failed to find closest event by timestamp",
    );
  }

  getSpaceChildEdges(db: D1Database, roomId: string): Promise<SpaceChildEdge[]> {
    return this.repository.getSpaceChildEdges(db, roomId);
  }

  getSpaceChildEdgesEffect(
    db: D1Database,
    roomId: string,
  ): Effect.Effect<SpaceChildEdge[], InfraError> {
    return fromInfraPromise(
      () => this.repository.getSpaceChildEdges(db, roomId),
      "Failed to load space child edges",
    );
  }

  getRoomPublicInfo(db: D1Database, roomId: string): Promise<PublicRoomSummary | null> {
    return this.repository.getRoomPublicInfo(db, roomId);
  }

  getRoomPublicInfoEffect(
    db: D1Database,
    roomId: string,
  ): Effect.Effect<PublicRoomSummary | null, InfraError> {
    return fromInfraPromise(
      () => this.repository.getRoomPublicInfo(db, roomId),
      "Failed to load public room info",
    );
  }

  isRoomVisibleToUser(db: D1Database, roomId: string, userId: string): Promise<boolean> {
    return this.repository.isRoomVisibleToUser(db, roomId, userId);
  }

  isRoomVisibleToUserEffect(
    db: D1Database,
    roomId: string,
    userId: string,
  ): Effect.Effect<boolean, InfraError> {
    return fromInfraPromise(
      () => this.repository.isRoomVisibleToUser(db, roomId, userId),
      "Failed to check room visibility",
    );
  }
}
