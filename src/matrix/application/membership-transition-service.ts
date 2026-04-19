import { Effect } from "effect";
import {
  loadMembershipTransitionContextFromRepository,
  persistMembershipTransitionResult,
} from "../../infra/repositories/membership-transition-repository";
import type { Membership, PDU } from "../../shared/types";
import { toEventId, toRoomId, toUserId } from "../../shared/utils/ids";
import type { MembershipRecord } from "../../infra/repositories/interfaces";
import { InfraError } from "./domain-error";
import { fromInfraPromise, fromInfraVoid } from "../../shared/effect/infra-effect";

export type MembershipTransitionSource = "client" | "federation" | "workflow";
export type MembershipSyncCategory = "invite" | "join" | "leave" | "knock";

export type StrippedStateEvent = {
  type: string;
  state_key: string;
  content: Record<string, unknown>;
  sender: string;
};

export interface MembershipTransitionInput {
  event: PDU;
  roomId: string;
  source: MembershipTransitionSource;
  currentMembership: MembershipRecord | null;
  currentMemberEvent: PDU | null;
  roomState: PDU[];
  inviteStrippedState: StrippedStateEvent[];
}

export interface MembershipTransitionContext {
  currentMembership: MembershipRecord | null;
  currentMemberEvent: PDU | null;
  roomState: PDU[];
  inviteStrippedState: StrippedStateEvent[];
}

export interface MembershipTransitionResult {
  membershipToPersist: "invite" | "join" | "leave" | "ban" | "knock" | null;
  shouldUpsertRoomState: boolean;
  shouldClearInviteStrippedState: boolean;
  shouldUpsertKnockState: boolean;
  shouldClearKnockState: boolean;
  syncCategory: MembershipSyncCategory;
}

export type MembershipCommand =
  | {
      kind: "invite";
      roomId: string;
      sender: string;
      targetUserId: string;
      source: MembershipTransitionSource;
      event: PDU;
    }
  | {
      kind: "join";
      roomId: string;
      sender: string;
      targetUserId: string;
      source: MembershipTransitionSource;
      event: PDU;
    }
  | {
      kind: "leave";
      roomId: string;
      sender: string;
      targetUserId: string;
      source: MembershipTransitionSource;
      event: PDU;
    }
  | {
      kind: "ban";
      roomId: string;
      sender: string;
      targetUserId: string;
      source: MembershipTransitionSource;
      event: PDU;
    }
  | {
      kind: "knock";
      roomId: string;
      sender: string;
      targetUserId: string;
      source: MembershipTransitionSource;
      event: PDU;
    };

export type TransitionContextLoader = (
  db: D1Database,
  roomId: string,
  stateKey?: string,
) => Promise<MembershipTransitionContext>;

export interface MembershipTransitionPorts {
  transitionRepository: {
    loadContext(
      roomId: string,
      stateKey?: string,
    ): Effect.Effect<MembershipTransitionContext, InfraError>;
    persistResult(input: {
      roomId: string;
      event: PDU;
      result: MembershipTransitionResult;
    }): Effect.Effect<void, InfraError>;
  };
}

export function createMembershipTransitionPorts(db: D1Database): MembershipTransitionPorts {
  return {
    transitionRepository: {
      loadContext: (roomId, stateKey) =>
        fromInfraPromise(
          () => loadMembershipTransitionContextFromRepository(db, roomId, stateKey),
          "Failed to load membership transition context",
        ),
      persistResult: (input) =>
        fromInfraVoid(
          () => persistMembershipTransitionResult(db, input),
          "Failed to persist membership transition",
        ),
    },
  };
}

function toAuthStateFromInviteStrippedState(
  roomId: string,
  strippedState: StrippedStateEvent[],
): PDU[] {
  const typedRoomId = toRoomId(roomId);
  if (!typedRoomId) {
    return [];
  }
  return strippedState.flatMap((event, index) => {
    const eventId = toEventId(`$invite-stripped-${index}`);
    const sender = toUserId(event.sender);
    if (!eventId || !sender) {
      return [];
    }
    return [
      {
        event_id: eventId,
        room_id: typedRoomId,
        sender,
        type: event.type,
        state_key: event.state_key,
        content: event.content,
        origin_server_ts: 0,
        depth: 0,
        auth_events: [],
        prev_events: [],
      },
    ];
  });
}

export function resolveMembershipAuthState(
  roomId: string,
  roomState: PDU[],
  inviteStrippedState: StrippedStateEvent[],
): PDU[] {
  if (inviteStrippedState.length === 0) {
    return roomState;
  }

  const hasCreate = roomState.some(
    (event) => event.type === "m.room.create" && event.state_key === "",
  );
  if (hasCreate) {
    return roomState;
  }

  const merged = new Map<string, PDU>();
  for (const event of roomState) {
    if (event.state_key !== undefined) {
      merged.set(`${event.type}\u0000${event.state_key}`, event);
    }
  }

  for (const event of toAuthStateFromInviteStrippedState(roomId, inviteStrippedState)) {
    merged.set(`${event.type}\u0000${event.state_key ?? ""}`, event);
  }

  return Array.from(merged.values());
}

function getMembershipEventMembership(event: PDU | null | undefined): Membership | null {
  if (!event || event.type !== "m.room.member") {
    return null;
  }

  const membership = (event.content as { membership?: Membership } | undefined)?.membership;
  return membership ?? null;
}

function getCurrentMemberEvent(
  roomId: string,
  stateKey: string,
  roomState: PDU[],
  inviteStrippedState: StrippedStateEvent[],
  explicitCurrentMemberEvent: PDU | null,
): PDU | null {
  if (explicitCurrentMemberEvent) {
    return explicitCurrentMemberEvent;
  }

  const authState = resolveMembershipAuthState(roomId, roomState, inviteStrippedState);
  return (
    authState.find((event) => event.type === "m.room.member" && event.state_key === stateKey) ??
    null
  );
}

function toSyncCategory(membership: Membership | null | undefined): MembershipSyncCategory {
  if (membership === "invite" || membership === "leave" || membership === "knock") {
    return membership;
  }
  if (membership === "ban") {
    return "leave";
  }
  return "join";
}

export function toMembershipCommand(input: MembershipTransitionInput): MembershipCommand | null {
  const membership = (input.event.content as { membership?: Membership } | undefined)?.membership;
  if (
    input.event.type !== "m.room.member" ||
    input.event.state_key === undefined ||
    !membership ||
    !["invite", "join", "leave", "ban", "knock"].includes(membership)
  ) {
    return null;
  }

  return {
    kind: membership as MembershipCommand["kind"],
    roomId: input.roomId,
    sender: input.event.sender,
    targetUserId: input.event.state_key,
    source: input.source,
    event: input.event,
  };
}

export class MemberTransitionService {
  evaluate(input: MembershipTransitionInput): MembershipTransitionResult {
    const command = toMembershipCommand(input);
    if (!command) {
      return {
        membershipToPersist: null,
        shouldUpsertRoomState: false,
        shouldClearInviteStrippedState: false,
        shouldUpsertKnockState: false,
        shouldClearKnockState: false,
        syncCategory: toSyncCategory(input.currentMembership?.membership),
      };
    }

    const currentMemberEvent = getCurrentMemberEvent(
      command.roomId,
      command.targetUserId,
      input.roomState,
      input.inviteStrippedState,
      input.currentMemberEvent,
    );
    const previousMembership =
      input.currentMembership?.membership ?? getMembershipEventMembership(currentMemberEvent);
    const previousInviteSender =
      previousMembership === "invite"
        ? (currentMemberEvent?.sender ??
          input.inviteStrippedState.find(
            (event) => event.type === "m.room.member" && event.state_key === command.targetUserId,
          )?.sender)
        : undefined;

    if (
      command.source === "federation" &&
      command.kind === "leave" &&
      previousMembership === "invite" &&
      command.sender !== command.targetUserId &&
      previousInviteSender &&
      previousInviteSender !== command.sender
    ) {
      return {
        membershipToPersist: null,
        shouldUpsertRoomState: false,
        shouldClearInviteStrippedState: false,
        shouldUpsertKnockState: false,
        shouldClearKnockState: false,
        syncCategory: "invite",
      };
    }

    return {
      membershipToPersist: command.kind,
      shouldUpsertRoomState: input.event.state_key !== undefined,
      shouldClearInviteStrippedState: command.kind !== "invite" && previousMembership === "invite",
      shouldUpsertKnockState: command.kind === "knock",
      shouldClearKnockState: command.kind !== "knock" && previousMembership === "knock",
      syncCategory: toSyncCategory(command.kind),
    };
  }
}

export const MembershipTransitionService = MemberTransitionService;

export function applyMembershipTransitionEffect(
  ports: MembershipTransitionPorts,
  input: {
    roomId: string;
    event: PDU;
    source: MembershipTransitionSource;
    context?: MembershipTransitionContext;
  },
): Effect.Effect<MembershipTransitionResult, InfraError> {
  return Effect.gen(function* () {
    const stateKey = input.event.state_key;
    const context =
      input.context ??
      (yield* ports.transitionRepository.loadContext(input.roomId, input.event.state_key));

    const service = new MemberTransitionService();
    const result = service.evaluate({
      event: input.event,
      roomId: input.roomId,
      source: input.source,
      currentMembership: context.currentMembership,
      currentMemberEvent: context.currentMemberEvent,
      roomState: context.roomState,
      inviteStrippedState: context.inviteStrippedState,
    });

    if (stateKey) {
      yield* ports.transitionRepository.persistResult({
        roomId: input.roomId,
        event: input.event,
        result,
      });
    }

    return result;
  });
}

export function applyMembershipTransitionToDatabase(
  db: D1Database,
  input: {
    roomId: string;
    event: PDU;
    source: MembershipTransitionSource;
    context?: MembershipTransitionContext;
  },
): Promise<MembershipTransitionResult> {
  return Effect.runPromise(
    applyMembershipTransitionEffect(createMembershipTransitionPorts(db), input),
  );
}

export function loadMembershipTransitionContext(
  db: D1Database,
  roomId: string,
  stateKey?: string,
): Promise<MembershipTransitionContext> {
  return loadMembershipTransitionContextFromRepository(db, roomId, stateKey);
}
