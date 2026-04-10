import type { AppEnv } from "../../shared/types";
import {
  getFederationEventRowById,
  toFederationPduFromRow,
} from "../../infra/repositories/federation-events-repository";

export async function fetchFederationEventById(
  env: Pick<AppEnv["Bindings"], "DB" | "SERVER_NAME">,
  eventId: string,
): Promise<{
  origin: string;
  origin_server_ts: number;
  pdus: ReturnType<typeof toFederationPduFromRow>[];
} | null> {
  const event = await getFederationEventRowById(env.DB, eventId);
  if (!event) {
    return null;
  }
  return {
    origin: env.SERVER_NAME,
    origin_server_ts: Date.now(),
    pdus: [toFederationPduFromRow(event)],
  };
}
