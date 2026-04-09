import {
  getInviteStrippedState,
  getMembership,
  getRoomState,
  getStateEvent,
  updateMembership,
} from "../../infra/db/database";
import type { Membership, PDU } from "../../shared/types";
import { toEventId, toRoomId, toUserId } from "../../shared/utils/ids";
import type { MembershipRecord } from "../../infra/repositories/interfaces";

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

async function upsertKnockRecord(
  db: D1Database,
  roomId: string,
  userId: string,
  event: PDU,
): Promise<void> {
  const user = await db
    .prepare(`
    SELECT user_id FROM users WHERE user_id = ?
  `)
    .bind(userId)
    .first<{ user_id: string }>();
  if (!user) {
    return;
  }

  const content = event.content as { reason?: string } | undefined;
  await db
    .prepare(`
    INSERT OR REPLACE INTO room_knocks (room_id, user_id, reason, event_id, created_at)
    VALUES (?, ?, ?, ?, ?)
  `)
    .bind(roomId, userId, content?.reason ?? null, event.event_id, Date.now())
    .run();
}

async function clearKnockRecord(db: D1Database, roomId: string, userId: string): Promise<void> {
  await db
    .prepare(`
    DELETE FROM room_knocks
    WHERE room_id = ? AND user_id = ?
  `)
    .bind(roomId, userId)
    .run();
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

export async function applyMembershipTransitionToDatabase(
  db: D1Database,
  input: {
    roomId: string;
    event: PDU;
    source: MembershipTransitionSource;
    context?: MembershipTransitionContext;
  },
): Promise<MembershipTransitionResult> {
  const stateKey = input.event.state_key;
  const context =
    input.context ??
    (await loadMembershipTransitionContext(db, input.roomId, input.event.state_key));

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

  if (stateKey && result.membershipToPersist) {
    const memberContent = input.event.content as { displayname?: string; avatar_url?: string };
    await updateMembership(
      db,
      toRoomId(input.roomId),
      toUserId(stateKey),
      result.membershipToPersist,
      toEventId(input.event.event_id),
      memberContent.displayname,
      memberContent.avatar_url,
    );
  }

  if (stateKey && result.shouldUpsertRoomState) {
    await db
      .prepare(`
      INSERT OR REPLACE INTO room_state (room_id, event_type, state_key, event_id)
      VALUES (?, ?, ?, ?)
    `)
      .bind(input.roomId, input.event.type, stateKey, input.event.event_id)
      .run();
  }

  if (stateKey && result.shouldUpsertKnockState) {
    await upsertKnockRecord(db, input.roomId, stateKey, input.event);
  } else if (stateKey && result.shouldClearKnockState) {
    await clearKnockRecord(db, input.roomId, stateKey);
  }

  return result;
}

export async function loadMembershipTransitionContext(
  db: D1Database,
  roomId: string,
  stateKey?: string,
): Promise<MembershipTransitionContext> {
  const typedRoomId = toRoomId(roomId);
  return {
    currentMembership: stateKey ? await getMembership(db, typedRoomId, toUserId(stateKey)) : null,
    currentMemberEvent: stateKey
      ? await getStateEvent(db, typedRoomId, "m.room.member", stateKey)
      : null,
    roomState: await getRoomState(db, typedRoomId),
    inviteStrippedState: await getInviteStrippedState(db, typedRoomId),
  };
}
