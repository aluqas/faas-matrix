import { Effect } from "effect";
import type { Membership, RoomJoinRulesContent } from "../../types";
import { ErrorCodes } from "../../types";
import { DomainError } from "./domain-error";
import { requireRoomVersionPolicy, type RoomVersionPolicy } from "./room-version-policy";

const JOIN_RULES = [
  "public",
  "knock",
  "invite",
  "private",
  "restricted",
  "knock_restricted",
] as const;

type JoinRule = (typeof JOIN_RULES)[number];

export interface JoinAuthorizationResult {
  alreadyJoined: boolean;
  joinRule: JoinRule;
  policy: RoomVersionPolicy;
}

export interface KnockAuthorizationResult {
  joinRule: JoinRule;
  policy: RoomVersionPolicy;
}

export interface InviteAuthorizationResult {
  inviterPower: number;
  invitePower: number;
}

export interface ModerationAuthorizationResult {
  actorPower: number;
}

function forbidden(message: string): DomainError {
  return new DomainError({
    kind: "auth_violation",
    errcode: ErrorCodes.M_FORBIDDEN,
    message,
    status: 403,
  });
}

function invalidRoomState(message: string): DomainError {
  return new DomainError({
    kind: "state_invariant",
    errcode: ErrorCodes.M_INVALID_ROOM_STATE,
    message,
    status: 400,
  });
}

function normalizeJoinRule(joinRule: unknown): Effect.Effect<JoinRule, DomainError> {
  if (joinRule === undefined || joinRule === null) {
    return Effect.succeed("invite");
  }

  if (typeof joinRule !== "string" || !JOIN_RULES.includes(joinRule as JoinRule)) {
    return Effect.fail(invalidRoomState("Room join rules event has an invalid join_rule"));
  }

  return Effect.succeed(joinRule as JoinRule);
}

function resolveJoinRuleContext(input: {
  roomVersion: string;
  joinRule: unknown;
}): Effect.Effect<{ joinRule: JoinRule; policy: RoomVersionPolicy }, DomainError> {
  let policy: RoomVersionPolicy;
  try {
    policy = requireRoomVersionPolicy(input.roomVersion);
  } catch (error) {
    return Effect.fail(error as DomainError);
  }

  return normalizeJoinRule(input.joinRule).pipe(
    Effect.flatMap((joinRule) => {
      if (!policy.supportsJoinRule(joinRule)) {
        return Effect.fail(
          invalidRoomState(
            `Join rule '${joinRule}' is not supported in room version '${input.roomVersion}'`,
          ),
        );
      }

      return Effect.succeed({ joinRule, policy });
    }),
  );
}

export function validateKnockPreconditions(
  currentMembership: Membership | null | undefined,
): Effect.Effect<void, DomainError> {
  if (currentMembership === "join") {
    return Effect.fail(forbidden("User is already joined to this room"));
  }

  if (currentMembership === "invite") {
    return Effect.fail(forbidden("User is already invited to this room"));
  }

  if (currentMembership === "ban") {
    return Effect.fail(forbidden("User is banned from this room"));
  }

  return Effect.void;
}

export function validateLeavePreconditions(
  currentMembership: Membership | null | undefined,
): Effect.Effect<void, DomainError> {
  if (
    currentMembership === "join" ||
    currentMembership === "invite" ||
    currentMembership === "knock"
  ) {
    return Effect.void;
  }

  return Effect.fail(forbidden("Not joined, invited, or knocking in this room"));
}

export function authorizeLocalInvite(input: {
  inviterMembership: Membership | null | undefined;
  inviteeMembership: Membership | null | undefined;
  inviterPower: number;
  invitePower: number;
}): Effect.Effect<InviteAuthorizationResult, DomainError> {
  if (input.inviterMembership !== "join") {
    return Effect.fail(forbidden("Not a member of this room"));
  }

  if (input.inviterPower < input.invitePower) {
    return Effect.fail(forbidden("Insufficient power level to invite"));
  }

  if (input.inviteeMembership === "join") {
    return Effect.fail(forbidden("User is already in the room"));
  }

  if (input.inviteeMembership === "ban") {
    return Effect.fail(forbidden("Cannot invite banned user"));
  }

  return Effect.succeed({
    inviterPower: input.inviterPower,
    invitePower: input.invitePower,
  });
}

export function authorizeKick(input: {
  actorMembership: Membership | null | undefined;
  targetMembership: Membership | null | undefined;
  actorPower: number;
  targetPower: number;
  kickPower: number;
  canRescindInvite: boolean;
}): Effect.Effect<ModerationAuthorizationResult, DomainError> {
  if (input.actorMembership !== "join") {
    return Effect.fail(forbidden("Not a member of this room"));
  }

  if (
    input.targetMembership !== "join" &&
    input.targetMembership !== "invite" &&
    input.targetMembership !== "knock"
  ) {
    return Effect.fail(forbidden("User is not joined, invited, or knocking"));
  }

  if (input.targetMembership === "invite" && !input.canRescindInvite) {
    return Effect.fail(forbidden("Only the original inviter can rescind an invite"));
  }

  if (input.actorPower < input.kickPower || input.actorPower <= input.targetPower) {
    return Effect.fail(forbidden("Insufficient power level to kick"));
  }

  return Effect.succeed({ actorPower: input.actorPower });
}

export function authorizeBan(input: {
  actorMembership: Membership | null | undefined;
  actorPower: number;
  targetPower: number;
  banPower: number;
}): Effect.Effect<ModerationAuthorizationResult, DomainError> {
  if (input.actorMembership !== "join") {
    return Effect.fail(forbidden("Not a member of this room"));
  }

  if (input.actorPower < input.banPower || input.actorPower <= input.targetPower) {
    return Effect.fail(forbidden("Insufficient power level to ban"));
  }

  return Effect.succeed({ actorPower: input.actorPower });
}

export function authorizeUnban(input: {
  actorMembership: Membership | null | undefined;
  targetMembership: Membership | null | undefined;
  actorPower: number;
  banPower: number;
}): Effect.Effect<ModerationAuthorizationResult, DomainError> {
  if (input.actorMembership !== "join") {
    return Effect.fail(forbidden("Not a member of this room"));
  }

  if (input.targetMembership !== "ban") {
    return Effect.fail(forbidden("User is not banned"));
  }

  if (input.actorPower < input.banPower) {
    return Effect.fail(forbidden("Insufficient power level to unban"));
  }

  return Effect.succeed({ actorPower: input.actorPower });
}

export function authorizeLocalKnock(input: {
  roomVersion: string;
  joinRule: unknown;
  currentMembership: Membership | null | undefined;
}): Effect.Effect<KnockAuthorizationResult, DomainError> {
  return validateKnockPreconditions(input.currentMembership).pipe(
    Effect.flatMap(() =>
      resolveJoinRuleContext({ roomVersion: input.roomVersion, joinRule: input.joinRule }),
    ),
    Effect.flatMap(({ joinRule, policy }) => {
      if (joinRule !== "knock" && joinRule !== "knock_restricted") {
        return Effect.fail(forbidden("Room does not allow knocking"));
      }

      return Effect.succeed({ joinRule, policy });
    }),
  );
}

export function authorizeLocalJoin(input: {
  roomVersion: string;
  joinRule: unknown;
  currentMembership: Membership | null | undefined;
  joinAuthorisedViaUsersServer?: string | null;
}): Effect.Effect<JoinAuthorizationResult, DomainError> {
  return resolveJoinRuleContext({
    roomVersion: input.roomVersion,
    joinRule: input.joinRule,
  }).pipe(
    Effect.flatMap(({ joinRule, policy }) => {
      if (input.currentMembership === "ban") {
        return Effect.fail(forbidden("User is banned from this room"));
      }

      if (input.currentMembership === "join") {
        return Effect.succeed<JoinAuthorizationResult>({ alreadyJoined: true, joinRule, policy });
      }

      if (input.currentMembership === "invite" || joinRule === "public") {
        return Effect.succeed<JoinAuthorizationResult>({
          alreadyJoined: false,
          joinRule,
          policy,
        });
      }

      if (
        (joinRule === "restricted" || joinRule === "knock_restricted") &&
        input.joinAuthorisedViaUsersServer
      ) {
        return Effect.succeed<JoinAuthorizationResult>({
          alreadyJoined: false,
          joinRule,
          policy,
        });
      }

      if (joinRule === "restricted" || joinRule === "knock_restricted") {
        return Effect.fail(forbidden("Cannot join restricted room without authorization"));
      }

      return Effect.fail(forbidden("Cannot join room"));
    }),
  );
}

export function getJoinRuleFromContent(
  content: { join_rule?: string } | Pick<RoomJoinRulesContent, "join_rule"> | null | undefined,
): JoinRule | "invite" {
  const joinRule = content?.join_rule;
  if (typeof joinRule !== "string") {
    return "invite";
  }
  return JOIN_RULES.includes(joinRule as JoinRule) ? (joinRule as JoinRule) : "invite";
}
