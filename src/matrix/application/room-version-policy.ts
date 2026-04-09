import type { RoomJoinRulesContent } from "../../shared/types";
import { ErrorCodes } from "../../shared/types";
import { getRoomVersion, type RoomVersionBehavior } from "../../infra/db/room-versions";
import { DomainError } from "./domain-error";

export interface RoomVersionPolicy extends RoomVersionBehavior {
  supportsJoinRule(joinRule: RoomJoinRulesContent["join_rule"]): boolean;
}

const BASE_JOIN_RULES: RoomJoinRulesContent["join_rule"][] = ["invite", "public", "private"];

export function getRoomVersionPolicy(version: string): RoomVersionPolicy | null {
  const behavior = getRoomVersion(version);
  if (!behavior) {
    return null;
  }

  return {
    ...behavior,
    supportsJoinRule(joinRule) {
      if (BASE_JOIN_RULES.includes(joinRule)) {
        return true;
      }

      if (joinRule === "knock") {
        return behavior.knockingSupported;
      }

      if (joinRule === "restricted") {
        return behavior.restrictedJoinsSupported;
      }

      if (joinRule === "knock_restricted") {
        return behavior.knockRestrictedSupported;
      }

      return false;
    },
  };
}

export function requireRoomVersionPolicy(version: string): RoomVersionPolicy {
  const policy = getRoomVersionPolicy(version);
  if (!policy) {
    throw new DomainError({
      kind: "incompatible_room_version",
      errcode: ErrorCodes.M_INCOMPATIBLE_ROOM_VERSION,
      message: `Unsupported room version: ${version}`,
      status: 400,
    });
  }
  return policy;
}
