import type { PDU } from "../../../shared/types";
import type { PublicRoomSummary } from "../../../shared/types/client";
import type { MissingEventsQuery, TimestampDirection } from "../../../shared/types/events";
import {
  EventQueryRepository,
  type SpaceChildEdge,
} from "../../../infra/repositories/event-query-repository";

export type { MissingEventsQuery, SpaceChildEdge, TimestampDirection };

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
  constructor(private readonly repository = new EventQueryRepository()) {}

  getVisibleEventForUser(
    db: D1Database,
    roomId: string,
    eventId: string,
    userId: string,
  ): Promise<PDU | null> {
    return this.repository.getVisibleEventForUser(db, roomId, eventId, userId);
  }

  roomExists(db: D1Database, roomId: string): Promise<boolean> {
    return this.repository.roomExists(db, roomId);
  }

  getMissingEvents(db: D1Database, query: MissingEventsQuery): Promise<PDU[]> {
    return this.repository.getMissingEvents(db, query);
  }

  findClosestEventByTimestamp(
    db: D1Database,
    roomId: string,
    ts: number,
    dir: TimestampDirection,
  ): Promise<{ event_id: string; origin_server_ts: number } | null> {
    return this.repository.findClosestEventByTimestamp(db, roomId, ts, dir);
  }

  getSpaceChildEdges(db: D1Database, roomId: string): Promise<SpaceChildEdge[]> {
    return this.repository.getSpaceChildEdges(db, roomId);
  }

  getRoomPublicInfo(db: D1Database, roomId: string): Promise<PublicRoomSummary | null> {
    return this.repository.getRoomPublicInfo(db, roomId);
  }

  isRoomVisibleToUser(db: D1Database, roomId: string, userId: string): Promise<boolean> {
    return this.repository.isRoomVisibleToUser(db, roomId, userId);
  }
}
