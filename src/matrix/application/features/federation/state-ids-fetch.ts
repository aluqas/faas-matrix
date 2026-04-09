import { getAuthChain } from "../../../../services/database";
import { getFederationRoomRecord, listFederationStateEventIdRows } from "../../../repositories/federation-events-repository";
import type { AppEnv } from "../../../../types";

export async function fetchFederationStateIds(
  env: Pick<AppEnv["Bindings"], "DB">,
  roomId: string,
): Promise<{ pdu_ids: string[]; auth_chain_ids: string[] } | null> {
  const room = await getFederationRoomRecord(env.DB, roomId);
  if (!room) {
    return null;
  }

  const stateEvents = await listFederationStateEventIdRows(env.DB, roomId);
  const stateEventIds = stateEvents.map((event) => event.event_id);
  const rootAuthEventIds = Array.from(
    new Set(
      stateEvents.flatMap((event) => {
        try {
          const authEvents = JSON.parse(event.auth_events) as unknown;
          return Array.isArray(authEvents)
            ? authEvents.filter((authId): authId is string => typeof authId === "string")
            : [];
        } catch {
          return [];
        }
      }),
    ),
  );
  const authChainIds = (await getAuthChain(env.DB, rootAuthEventIds)).map((event) => event.event_id);

  return {
    pdu_ids: stateEventIds,
    auth_chain_ids: authChainIds,
  };
}
