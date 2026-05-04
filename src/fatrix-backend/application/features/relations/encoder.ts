import type { PDU } from "../../../../fatrix-model/types";
import type { ClientRelationEvent } from "./query";

export function encodeEventRelationshipsResponse(input: { events: PDU[]; limited: boolean }): {
  events: PDU[];
  limited: boolean;
} {
  return {
    events: input.events,
    limited: input.limited,
  };
}

export function encodeRelationChunkResponse(input: {
  chunk: ClientRelationEvent[];
  nextBatch?: string;
}): { chunk: ClientRelationEvent[]; next_batch?: string } {
  return {
    chunk: input.chunk,
    ...(input.nextBatch ? { next_batch: input.nextBatch } : {}),
  };
}

export function encodeThreadSubscriptionResponse(input: { automatic: boolean }): {
  automatic: boolean;
} {
  return {
    automatic: input.automatic,
  };
}

export function encodeEmptyRelationsResponse(): Record<string, never> {
  return {};
}
