import { EventQueryService } from "../../matrix/application/orchestrators/event-query-service";
import { getFederationRoomRecord } from "../../infra/repositories/federation-events-repository";
import type { AppEnv, EventId, PDU, RoomId } from "../../shared/types";

const queries = new EventQueryService();

export async function fetchFederationMissingEvents(input: {
  env: Pick<AppEnv["Bindings"], "DB">;
  roomId: string;
  earliestEvents: EventId[];
  latestEvents: EventId[];
  limit: number;
  minDepth: number;
  requestingServer?: string;
}): Promise<PDU[] | null> {
  const room = await getFederationRoomRecord(input.env.DB, input.roomId);
  if (!room) {
    return null;
  }

  return queries.getMissingEvents(input.env.DB, {
    roomId: room.roomId as RoomId,
    earliestEvents: input.earliestEvents,
    latestEvents: input.latestEvents,
    limit: input.limit,
    minDepth: input.minDepth,
    roomVersion: room.roomVersion,
    requestingServer: input.requestingServer,
  });
}
