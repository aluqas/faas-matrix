import type { Membership, PDU, RoomMemberContent } from "../../../../fatrix-model/types";

export const PARTIAL_STATE_AUTH_DEFERRED_UNSIGNED_KEY = "io.tuwunel.partial_state_auth_deferred";
export const PARTIAL_STATE_AUTH_DEFERRED_PREVIOUS_EVENT_ID_UNSIGNED_KEY =
  "io.tuwunel.partial_state_auth_deferred_previous_event_id";
export const PARTIAL_STATE_AUTH_DEFERRED_PREVIOUS_MEMBERSHIP_UNSIGNED_KEY =
  "io.tuwunel.partial_state_auth_deferred_previous_membership";

type MembershipEventLike = Pick<PDU, "event_id" | "type" | "content" | "unsigned">;
type DeferredAuthEventLike = Pick<PDU, "unsigned">;

export function getMembershipEventMembership(
  event: MembershipEventLike | null | undefined,
): Membership | null {
  if (!event || event.type !== "m.room.member") {
    return null;
  }

  const membership = (event.content as RoomMemberContent | undefined)?.membership;
  return membership ?? null;
}

export function getPartialStateDeferredAuthReason(
  event: DeferredAuthEventLike | null | undefined,
): string | null {
  if (!event?.unsigned || typeof event.unsigned !== "object") {
    return null;
  }

  const value = (event.unsigned as Record<string, unknown>)[
    PARTIAL_STATE_AUTH_DEFERRED_UNSIGNED_KEY
  ];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function markPartialStateDeferredAuthEvent<T extends PDU>(event: T, reason: string): T {
  return {
    ...event,
    unsigned: {
      ...event.unsigned,
      [PARTIAL_STATE_AUTH_DEFERRED_UNSIGNED_KEY]: reason,
    },
  };
}

export function isPartialStateDeferredMembershipEvent(
  event: MembershipEventLike | null | undefined,
): boolean {
  return getPartialStateDeferredAuthReason(event) !== null;
}

export function getPartialStateDeferredPreviousEventId(
  event: MembershipEventLike | null | undefined,
): string | null {
  if (!event?.unsigned || typeof event.unsigned !== "object") {
    return null;
  }

  const value = (event.unsigned as Record<string, unknown>)[
    PARTIAL_STATE_AUTH_DEFERRED_PREVIOUS_EVENT_ID_UNSIGNED_KEY
  ];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function getPartialStateDeferredPreviousMembership(
  event: MembershipEventLike | null | undefined,
): Membership | null {
  if (!event?.unsigned || typeof event.unsigned !== "object") {
    return null;
  }

  const value = (event.unsigned as Record<string, unknown>)[
    PARTIAL_STATE_AUTH_DEFERRED_PREVIOUS_MEMBERSHIP_UNSIGNED_KEY
  ];
  return typeof value === "string" && ["join", "invite", "leave", "ban", "knock"].includes(value)
    ? (value as Membership)
    : null;
}

export function markPartialStateDeferredMembershipEvent<T extends PDU>(
  event: T,
  input: {
    reason: string;
    previousEvent?: MembershipEventLike | null;
  },
): T {
  const previousMembership = getMembershipEventMembership(input.previousEvent);
  const markedEvent = markPartialStateDeferredAuthEvent(event, input.reason);
  return {
    ...markedEvent,
    unsigned: {
      ...markedEvent.unsigned,
      ...(input.previousEvent
        ? {
            [PARTIAL_STATE_AUTH_DEFERRED_PREVIOUS_EVENT_ID_UNSIGNED_KEY]:
              input.previousEvent.event_id,
          }
        : {}),
      ...(previousMembership
        ? {
            [PARTIAL_STATE_AUTH_DEFERRED_PREVIOUS_MEMBERSHIP_UNSIGNED_KEY]: previousMembership,
          }
        : {}),
    },
  };
}
