import { calculateReferenceHashEventId } from "../../shared/utils/crypto";
import type { AppEnv, EventId, PDU } from "../../shared/types";
import { toEventId } from "../../shared/utils/ids";
import {
  getFederationEventAuthSeed,
  getFederationEventRowByReference,
  getFederationRoomRecord,
  toFederationPduFromRow,
} from "../../infra/repositories/federation-events-repository";

export async function fetchFederationEventAuth(input: {
  env: Pick<AppEnv["Bindings"], "DB">;
  roomId: string;
  eventId: string;
}): Promise<
  | null
  | {
      authChain: PDU[];
      requestedAuthEvents: EventId[];
      returnedAuthChain: Array<{
        event_id: string;
        calculated_event_id: string;
        type: string;
        state_key?: string;
        origin_server_ts: number;
        depth: number;
        auth_events: EventId[];
        prev_events: EventId[];
      }>;
      missingAuthEvents: string[];
    }
> {
  const room = await getFederationRoomRecord(input.env.DB, input.roomId);
  if (!room) {
    return null;
  }
  const event = await getFederationEventAuthSeed(input.env.DB, input.roomId, input.eventId);
  if (!event) {
    return null;
  }

  const authChain: PDU[] = [];
  const visited = new Set<string>();
  const toProcess = JSON.parse(event.auth_events) as string[];
  const missingAuthEvents: string[] = [];
  const authChainSummaries: Array<{
    event_id: string;
    calculated_event_id: string;
    type: string;
    state_key?: string;
    origin_server_ts: number;
    depth: number;
    auth_events: EventId[];
    prev_events: EventId[];
  }> = [];

  while (toProcess.length > 0) {
    const authId = toProcess.shift()!;
    if (visited.has(authId)) {
      continue;
    }
    visited.add(authId);

    const authEvent = await getFederationEventRowByReference(input.env.DB, authId);
    if (!authEvent) {
      missingAuthEvents.push(authId);
      continue;
    }

    const pdu = toFederationPduFromRow(authEvent);
    authChain.push(pdu);

    const calculatedEventId = await calculateReferenceHashEventId(
      pdu as unknown as Record<string, unknown>,
      room.roomVersion,
    );
    authChainSummaries.push({
      event_id: pdu.event_id,
      calculated_event_id: calculatedEventId,
      type: pdu.type,
      state_key: pdu.state_key,
      origin_server_ts: pdu.origin_server_ts,
      depth: pdu.depth,
      auth_events: pdu.auth_events,
      prev_events: pdu.prev_events,
    });

    for (const id of pdu.auth_events) {
      if (!visited.has(id)) {
        toProcess.push(id);
      }
    }
  }

  return {
    authChain,
    requestedAuthEvents: (JSON.parse(event.auth_events) as string[])
      .map((value) => toEventId(value))
      .filter((value): value is EventId => value !== null),
    returnedAuthChain: authChainSummaries,
    missingAuthEvents,
  };
}
