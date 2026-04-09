import type { PDU, RoomPowerLevelsContent } from "../../shared/types";

export function getPowerLevelsContent(
  powerLevelsEvent: PDU | null | undefined,
): RoomPowerLevelsContent {
  const content = powerLevelsEvent?.content;
  if (!content || typeof content !== "object") {
    return {
      users_default: 0,
      events_default: 0,
      state_default: 50,
      ban: 50,
      kick: 50,
      redact: 50,
      invite: 0,
      users: {},
      events: {},
    };
  }

  return content as RoomPowerLevelsContent;
}

export function getUserPowerLevel(powerLevels: RoomPowerLevelsContent, userId: string): number {
  return (
    powerLevels.users?.[userId as keyof typeof powerLevels.users] ?? powerLevels.users_default ?? 0
  );
}

export function getRequiredEventPowerLevel(
  powerLevels: RoomPowerLevelsContent,
  eventType: string,
  isStateEvent: boolean,
): number {
  const eventLevel = powerLevels.events?.[eventType];
  if (typeof eventLevel === "number") {
    return eventLevel;
  }

  return isStateEvent ? (powerLevels.state_default ?? 50) : (powerLevels.events_default ?? 0);
}
