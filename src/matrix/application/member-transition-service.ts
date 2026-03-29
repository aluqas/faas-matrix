import {
  getInviteStrippedState,
  getMembership,
  getRoomState,
  getStateEvent,
  updateMembership,
} from '../../services/database';
import type { Membership, PDU } from '../../types';
import type { MembershipRecord } from '../repositories/interfaces';

export type MembershipTransitionSource = 'client' | 'federation' | 'workflow';
export type MembershipSyncCategory = 'invite' | 'join' | 'leave' | 'knock';

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
  membershipToPersist: 'invite' | 'join' | 'leave' | 'knock' | null;
  shouldUpsertRoomState: boolean;
  shouldClearInviteStrippedState: boolean;
  shouldUpsertKnockState: boolean;
  shouldClearKnockState: boolean;
  syncCategory: MembershipSyncCategory;
}

export type TransitionContextLoader = (
  db: D1Database,
  roomId: string,
  stateKey?: string
) => Promise<MembershipTransitionContext>;

function toAuthStateFromInviteStrippedState(
  roomId: string,
  strippedState: StrippedStateEvent[]
): PDU[] {
  return strippedState.map((event, index) => ({
    event_id: `$invite-stripped-${index}`,
    room_id: roomId,
    sender: event.sender,
    type: event.type,
    state_key: event.state_key,
    content: event.content,
    origin_server_ts: 0,
    depth: 0,
    auth_events: [],
    prev_events: [],
  }));
}

export function resolveMembershipAuthState(
  roomId: string,
  roomState: PDU[],
  inviteStrippedState: StrippedStateEvent[]
): PDU[] {
  if (inviteStrippedState.length === 0) {
    return roomState;
  }

  const hasCreate = roomState.some(
    (event) => event.type === 'm.room.create' && event.state_key === ''
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
    merged.set(`${event.type}\u0000${event.state_key ?? ''}`, event);
  }

  return Array.from(merged.values());
}

function getMembershipEventMembership(event: PDU | null | undefined): Membership | null {
  if (!event || event.type !== 'm.room.member') {
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
  explicitCurrentMemberEvent: PDU | null
): PDU | null {
  if (explicitCurrentMemberEvent) {
    return explicitCurrentMemberEvent;
  }

  const authState = resolveMembershipAuthState(roomId, roomState, inviteStrippedState);
  return authState.find(
    (event) => event.type === 'm.room.member' && event.state_key === stateKey
  ) ?? null;
}

function toSyncCategory(membership: Membership | null | undefined): MembershipSyncCategory {
  if (membership === 'invite' || membership === 'leave' || membership === 'knock') {
    return membership;
  }
  return 'join';
}

async function upsertKnockRecord(
  db: D1Database,
  roomId: string,
  userId: string,
  event: PDU
): Promise<void> {
  const content = event.content as { reason?: string } | undefined;
  await db.prepare(`
    INSERT OR REPLACE INTO room_knocks (room_id, user_id, reason, event_id, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).bind(roomId, userId, content?.reason ?? null, event.event_id, Date.now()).run();
}

async function clearKnockRecord(db: D1Database, roomId: string, userId: string): Promise<void> {
  await db.prepare(`
    DELETE FROM room_knocks
    WHERE room_id = ? AND user_id = ?
  `).bind(roomId, userId).run();
}

export class MemberTransitionService {
  evaluate(input: MembershipTransitionInput): MembershipTransitionResult {
    const membership = (input.event.content as { membership?: Membership } | undefined)?.membership;
    if (input.event.type !== 'm.room.member' || input.event.state_key === undefined || !membership) {
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
      input.roomId,
      input.event.state_key,
      input.roomState,
      input.inviteStrippedState,
      input.currentMemberEvent
    );
    const previousMembership =
      input.currentMembership?.membership ?? getMembershipEventMembership(currentMemberEvent);
    const previousInviteSender =
      previousMembership === 'invite'
        ? currentMemberEvent?.sender ??
          input.inviteStrippedState.find(
            (event) => event.type === 'm.room.member' && event.state_key === input.event.state_key
          )?.sender
        : undefined;

    if (
      input.source === 'federation' &&
      membership === 'leave' &&
      previousMembership === 'invite' &&
      input.event.sender !== input.event.state_key &&
      previousInviteSender &&
      previousInviteSender !== input.event.sender
    ) {
      return {
        membershipToPersist: null,
        shouldUpsertRoomState: false,
        shouldClearInviteStrippedState: false,
        shouldUpsertKnockState: false,
        shouldClearKnockState: false,
        syncCategory: 'invite',
      };
    }

    if (!['invite', 'join', 'leave', 'knock'].includes(membership)) {
      return {
        membershipToPersist: null,
        shouldUpsertRoomState: false,
        shouldClearInviteStrippedState: false,
        shouldUpsertKnockState: false,
        shouldClearKnockState: false,
        syncCategory: toSyncCategory(previousMembership),
      };
    }

    return {
      membershipToPersist: membership as 'invite' | 'join' | 'leave' | 'knock',
      shouldUpsertRoomState: input.event.state_key !== undefined,
      shouldClearInviteStrippedState: membership !== 'invite' && previousMembership === 'invite',
      shouldUpsertKnockState: membership === 'knock',
      shouldClearKnockState: membership !== 'knock' && previousMembership === 'knock',
      syncCategory: toSyncCategory(membership),
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
  }
): Promise<MembershipTransitionResult> {
  const stateKey = input.event.state_key;
  const context = input.context ?? await loadMembershipTransitionContext(
    db,
    input.roomId,
    input.event.state_key
  );

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
      input.roomId,
      stateKey,
      result.membershipToPersist,
      input.event.event_id,
      memberContent.displayname,
      memberContent.avatar_url
    );
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
  stateKey?: string
): Promise<MembershipTransitionContext> {
  return {
    currentMembership: stateKey ? await getMembership(db, roomId, stateKey) : null,
    currentMemberEvent: stateKey ? await getStateEvent(db, roomId, 'm.room.member', stateKey) : null,
    roomState: await getRoomState(db, roomId),
    inviteStrippedState: await getInviteStrippedState(db, roomId),
  };
}
