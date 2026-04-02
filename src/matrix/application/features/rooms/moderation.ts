import type { MembershipRecord } from "../../../repositories/interfaces";
import type { PDU } from "../../../../types";
import { createMembershipEvent } from "../../rooms-support";
import { getPowerLevelsContent, getUserPowerLevel } from "./power-levels";

function withOptionalValue<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  if (value === undefined) {
    return {};
  }

  return { [key]: value } as { [P in K]?: V };
}

export interface ModerationAuthorizationContext {
  actorMembership: MembershipRecord | null;
  targetMembership: MembershipRecord | null;
  targetMembershipEvent: PDU | null;
  actorPower: number;
  targetPower: number;
  kickPower: number;
  banPower: number;
}

export function buildModerationAuthorizationContext(input: {
  actorUserId: string;
  targetUserId: string;
  actorMembership: MembershipRecord | null;
  targetMembership: MembershipRecord | null;
  targetMembershipEvent: PDU | null;
  powerLevelsEvent: PDU | null;
}): ModerationAuthorizationContext {
  const powerLevels = getPowerLevelsContent(input.powerLevelsEvent);

  return {
    actorMembership: input.actorMembership,
    targetMembership: input.targetMembership,
    targetMembershipEvent: input.targetMembershipEvent,
    actorPower: getUserPowerLevel(powerLevels, input.actorUserId),
    targetPower: getUserPowerLevel(powerLevels, input.targetUserId),
    kickPower: powerLevels.kick ?? 50,
    banPower: powerLevels.ban ?? 50,
  };
}

export async function buildModerationMembershipEvent(input: {
  roomId: string;
  actorUserId: string;
  targetUserId: string;
  membership: "leave" | "ban";
  reason?: string;
  serverName: string;
  generateEventId: (serverName: string, roomVersion?: string) => Promise<string>;
  now: () => number;
  createEvent: PDU | null;
  powerLevelsEvent: PDU | null;
  actorMembership: MembershipRecord | null;
  targetMembership: MembershipRecord | null;
  targetMembershipEvent: PDU | null;
  latestEvents: PDU[];
}): Promise<PDU> {
  const targetMembershipContent = input.targetMembershipEvent?.content as
    | { membership?: unknown }
    | undefined;
  const prevContent =
    targetMembershipContent?.membership !== undefined
      ? (input.targetMembershipEvent?.content as Record<string, unknown>)
      : undefined;
  const prevSender = input.targetMembershipEvent?.sender;

  return createMembershipEvent({
    roomId: input.roomId,
    userId: input.targetUserId,
    sender: input.actorUserId,
    membership: input.membership,
    ...withOptionalValue("content", input.reason ? { reason: input.reason } : undefined),
    serverName: input.serverName,
    generateEventId: input.generateEventId,
    now: input.now,
    ...withOptionalValue("createEventId", input.createEvent?.event_id),
    ...withOptionalValue("powerLevelsEventId", input.powerLevelsEvent?.event_id),
    ...withOptionalValue(
      "currentMembershipEventId",
      input.targetMembership?.eventId ?? input.actorMembership?.eventId,
    ),
    prevEventIds: input.latestEvents.map((event) => event.event_id),
    depth: (input.latestEvents[0]?.depth ?? 0) + 1,
    ...withOptionalValue(
      "unsigned",
      prevContent
        ? {
            prev_content: prevContent,
            ...withOptionalValue("prev_sender", prevSender),
          }
        : undefined,
    ),
  });
}
