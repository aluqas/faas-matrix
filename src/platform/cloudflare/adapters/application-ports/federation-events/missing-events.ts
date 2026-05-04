import { EventQueryService } from "../../../../../fatrix-backend/application/orchestrators/event-query-service";
import { getFederationRoomRecord } from "../../repositories/federation-events-repository";
import type { EventId, PDU, RoomId } from "../../../../../fatrix-model/types";
import type { Env } from "../../../env";

const queries = new EventQueryService();

export async function fetchFederationMissingEvents(input: {
  env: Pick<Env, "DB">;
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
