import type { EventId, PDU, RoomId } from "../../../../fatrix-model/types";
import type { Env } from "../../env";

export const FEDERATION_OUTBOUND_DO_NAME = "outbound";

export interface FederationOutboundPort {
  enqueuePdu(input: {
    destination: string;
    eventId: EventId;
    roomId: RoomId;
    pdu: Record<string, unknown>;
  }): Promise<void>;
  enqueueEdu(input: {
    destination: string;
    eduType: string;
    content: Record<string, unknown>;
  }): Promise<void>;
}

function getOutboundStub(env: Pick<Env, "FEDERATION">): DurableObjectStub {
  return env.FEDERATION.get(env.FEDERATION.idFromName(FEDERATION_OUTBOUND_DO_NAME));
}

export function createFederationOutboundPort(env: Pick<Env, "FEDERATION">): FederationOutboundPort {
  return {
    async enqueuePdu(input) {
      const stub = getOutboundStub(env);
      await stub.fetch(
        new Request("http://internal/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            destination: input.destination,
            event_id: input.eventId,
            room_id: input.roomId,
            pdu: input.pdu,
          }),
        }),
      );
    },
    async enqueueEdu(input) {
      const stub = getOutboundStub(env);
      await stub.fetch(
        new Request("http://internal/send-edu", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            destination: input.destination,
            edu_type: input.eduType,
            content: input.content,
          }),
        }),
      );
    },
  };
}

export async function enqueueFederationPdu(
  env: Pick<Env, "FEDERATION">,
  destination: string,
  roomId: RoomId,
  event: PDU,
): Promise<void> {
  await createFederationOutboundPort(env).enqueuePdu({
    destination,
    eventId: event.event_id,
    roomId,
    pdu: event as unknown as Record<string, unknown>,
  });
}

export async function enqueueFederationEdu(
  env: Pick<Env, "FEDERATION">,
  destination: string,
  eduType: string,
  content: Record<string, unknown>,
): Promise<void> {
  await createFederationOutboundPort(env).enqueueEdu({
    destination,
    eduType,
    content,
  });
}
