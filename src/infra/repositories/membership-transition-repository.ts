import { sql, type RawBuilder } from "kysely";
import {
  createKyselyBuilder,
  executeKyselyQueryFirst,
  executeKyselyRun,
  type CompiledQuery,
} from "../../infra/db/kysely";
import {
  getInviteStrippedState,
  getMembership,
  getRoomState,
  getStateEvent,
  updateMembership,
} from "../../infra/db/database";
import type { PDU } from "../../shared/types";
import { toEventId, toRoomId, toUserId } from "../../shared/utils/ids";
import type {
  MembershipTransitionContext,
  MembershipTransitionResult,
} from "../../matrix/application/membership-transition-service";

interface MembershipTransitionDatabase {
  users: {
    user_id: string;
  };
  room_knocks: {
    room_id: string;
    user_id: string;
    reason: string | null;
    event_id: string;
    created_at: number;
  };
  room_state: {
    room_id: string;
    event_type: string;
    state_key: string;
    event_id: string;
  };
}

const qb = createKyselyBuilder<MembershipTransitionDatabase>();

function asCompiledQuery<T>(query: RawBuilder<T>): CompiledQuery {
  return {
    compile: () => query.compile(qb),
  };
}

async function userExists(db: D1Database, userId: string): Promise<boolean> {
  const row = await executeKyselyQueryFirst<{ user_id: string }>(
    db,
    asCompiledQuery(sql<{ user_id: string }>`
      SELECT user_id FROM users WHERE user_id = ${userId} LIMIT 1
    `),
  );

  return row !== null;
}

export async function upsertMembershipTransitionKnockRecord(
  db: D1Database,
  roomId: string,
  userId: string,
  event: PDU,
): Promise<void> {
  if (!(await userExists(db, userId))) {
    return;
  }

  const content = event.content as { reason?: string } | undefined;
  await executeKyselyRun(
    db,
    asCompiledQuery(sql`
      INSERT OR REPLACE INTO room_knocks (room_id, user_id, reason, event_id, created_at)
      VALUES (${roomId}, ${userId}, ${content?.reason ?? null}, ${event.event_id}, ${Date.now()})
    `),
  );
}

export function clearMembershipTransitionKnockRecord(
  db: D1Database,
  roomId: string,
  userId: string,
): Promise<void> {
  return executeKyselyRun(
    db,
    asCompiledQuery(sql`
      DELETE FROM room_knocks
      WHERE room_id = ${roomId} AND user_id = ${userId}
    `),
  );
}

export function upsertMembershipTransitionRoomState(
  db: D1Database,
  roomId: string,
  eventType: string,
  stateKey: string,
  eventId: string,
): Promise<void> {
  return executeKyselyRun(
    db,
    asCompiledQuery(sql`
      INSERT OR REPLACE INTO room_state (room_id, event_type, state_key, event_id)
      VALUES (${roomId}, ${eventType}, ${stateKey}, ${eventId})
    `),
  );
}

export async function loadMembershipTransitionContextFromRepository(
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

export async function persistMembershipTransitionResult(
  db: D1Database,
  input: {
    roomId: string;
    event: PDU;
    result: MembershipTransitionResult;
  },
): Promise<void> {
  const stateKey = input.event.state_key;
  if (!stateKey) {
    return;
  }

  if (input.result.membershipToPersist) {
    const memberContent = input.event.content as { displayname?: string; avatar_url?: string };
    await updateMembership(
      db,
      toRoomId(input.roomId),
      toUserId(stateKey),
      input.result.membershipToPersist,
      toEventId(input.event.event_id),
      memberContent.displayname,
      memberContent.avatar_url,
    );
  }

  if (input.result.shouldUpsertRoomState) {
    await upsertMembershipTransitionRoomState(
      db,
      input.roomId,
      input.event.type,
      stateKey,
      input.event.event_id,
    );
  }

  if (input.result.shouldUpsertKnockState) {
    await upsertMembershipTransitionKnockRecord(db, input.roomId, stateKey, input.event);
  } else if (input.result.shouldClearKnockState) {
    await clearMembershipTransitionKnockRecord(db, input.roomId, stateKey);
  }
}
