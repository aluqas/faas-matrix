import type { EventId } from "../../../../../fatrix-model/types";
import type { Env } from "../../../env";
import {
  getFederationRoomRecord,
  getMinimumDepthForEvents,
  listBackfillEventRows,
  toFederationPduFromRow,
} from "../../repositories/federation-events-repository";

export async function fetchFederationBackfill(input: {
  env: Pick<Env, "DB" | "SERVER_NAME">;
  roomId: string;
  limit: number;
  startEventIds: EventId[];
}): Promise<{
  origin: string;
  origin_server_ts: number;
  pdus: ReturnType<typeof toFederationPduFromRow>[];
} | null> {
  const room = await getFederationRoomRecord(input.env.DB, input.roomId);
  if (!room) {
    return null;
  }

  const maxDepth =
    input.startEventIds.length > 0
      ? await getMinimumDepthForEvents(input.env.DB, input.startEventIds)
      : null;
  const events = await listBackfillEventRows(input.env.DB, input.roomId, input.limit, maxDepth);

  return {
    origin: input.env.SERVER_NAME,
    origin_server_ts: Date.now(),
    pdus: events.map((row) => toFederationPduFromRow(row)),
  };
}
