import type { PDU } from "../../../../../fatrix-model/types";
import type { Env } from "../../../env";
import {
  getFederationEventRowById,
  listFederationStateEventRows,
  toFederationPduFromRow,
} from "../../repositories/federation-events-repository";

export async function fetchFederationState(
  env: Pick<Env, "DB" | "SERVER_NAME">,
  roomId: string,
): Promise<{ origin: string; origin_server_ts: number; pdus: PDU[]; auth_chain: PDU[] }> {
  const stateEvents = await listFederationStateEventRows(env.DB, roomId);
  const pdus = stateEvents.map((row) => toFederationPduFromRow(row));
  const authEventIds = new Set<string>();
  for (const pdu of pdus) {
    for (const authId of pdu.auth_events) {
      authEventIds.add(authId);
    }
  }

  const authRows = await Promise.all(
    Array.from(authEventIds).map((authId) => getFederationEventRowById(env.DB, authId)),
  );

  return {
    origin: env.SERVER_NAME,
    origin_server_ts: Date.now(),
    pdus,
    auth_chain: authRows
      .filter((row): row is NonNullable<typeof row> => row !== null)
      .map((row) => toFederationPduFromRow(row)),
  };
}
