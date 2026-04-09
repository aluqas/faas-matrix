import type { AppEnv, PDU } from "../../shared/types";
import {
  getFederationEventRowById,
  listFederationStateEventRows,
  toFederationPduFromRow,
} from "../../infra/repositories/federation-events-repository";

export async function fetchFederationState(
  env: Pick<AppEnv["Bindings"], "DB" | "SERVER_NAME">,
  roomId: string,
): Promise<{ origin: string; origin_server_ts: number; pdus: PDU[]; auth_chain: PDU[] }> {
  const stateEvents = await listFederationStateEventRows(env.DB, roomId);
  const pdus = stateEvents.map(toFederationPduFromRow);
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
    auth_chain: authRows.filter((row): row is NonNullable<typeof row> => row !== null).map(toFederationPduFromRow),
  };
}
