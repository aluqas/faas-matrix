import { sql, type RawBuilder } from "kysely";
import {
  createKyselyBuilder,
  executeKyselyQuery,
  executeKyselyQueryFirst,
  executeKyselyRun,
  type CompiledQuery,
} from "../../infra/db/kysely";

interface FederationMembershipDatabase {}

const qb = createKyselyBuilder<FederationMembershipDatabase>();

function asCompiledQuery<T>(query: RawBuilder<T>): CompiledQuery {
  return {
    compile: () => query.compile(qb),
  };
}

export interface FederationRoomRecord {
  roomId: string;
  roomVersion: string;
}

export interface FederationMembershipEventRef {
  eventId: string;
  membership: string;
}

export interface FederationStateMembershipRef {
  eventId: string;
  membership: string | null;
}

export interface FederationLatestEventRef {
  eventId: string;
  depth: number;
}

export interface FederationStateEventContentRef {
  eventId: string;
  content: string;
}

export interface FederationThirdPartyInviteRecord {
  eventId: string;
  content: string;
  sender: string;
  stateKey: string;
}

export interface FederationStrippedStateEvent {
  type: string;
  state_key: string;
  content: string;
  sender: string;
}

export interface FederationFullCreateEvent {
  event_id: string;
  room_id: string;
  event_type: string;
  state_key: string;
  content: string;
  sender: string;
  origin_server_ts: number;
  depth: number;
  auth_events: string;
  prev_events: string;
  hashes: string | null;
  signatures: string | null;
}

export async function getFederationRoomRecord(
  db: D1Database,
  roomId: string,
): Promise<FederationRoomRecord | null> {
  const row = await executeKyselyQueryFirst<{ room_id: string; room_version: string }>(
    db,
    asCompiledQuery(sql<{ room_id: string; room_version: string }>`
      SELECT room_id, room_version
      FROM rooms
      WHERE room_id = ${roomId}
    `),
  );
  return row ? { roomId: row.room_id, roomVersion: row.room_version } : null;
}

export function getFederationStateEventRef(
  db: D1Database,
  roomId: string,
  eventType: string,
): Promise<FederationStateEventContentRef | null> {
  return executeKyselyQueryFirst<FederationStateEventContentRef>(
    db,
    asCompiledQuery(sql<FederationStateEventContentRef>`
      SELECT e.event_id AS eventId, e.content AS content
      FROM room_state rs
      JOIN events e ON rs.event_id = e.event_id
      WHERE rs.room_id = ${roomId} AND rs.event_type = ${eventType}
    `),
  );
}

export async function getFederationStateEventId(
  db: D1Database,
  roomId: string,
  eventType: string,
): Promise<string | null> {
  const row = await getFederationStateEventRef(db, roomId, eventType);
  return row?.eventId ?? null;
}

export function getFederationMembershipRecord(
  db: D1Database,
  roomId: string,
  userId: string,
): Promise<FederationMembershipEventRef | null> {
  return executeKyselyQueryFirst<FederationMembershipEventRef>(
    db,
    asCompiledQuery(sql<FederationMembershipEventRef>`
      SELECT event_id AS eventId, membership
      FROM room_memberships
      WHERE room_id = ${roomId} AND user_id = ${userId}
    `),
  );
}

export function getFederationCurrentStateMembership(
  db: D1Database,
  roomId: string,
  userId: string,
): Promise<FederationStateMembershipRef | null> {
  return executeKyselyQueryFirst<FederationStateMembershipRef>(
    db,
    asCompiledQuery(sql<FederationStateMembershipRef>`
      SELECT e.event_id AS eventId, json_extract(e.content, '$.membership') AS membership
      FROM room_state rs
      JOIN events e ON rs.event_id = e.event_id
      WHERE rs.room_id = ${roomId}
        AND rs.event_type = 'm.room.member'
        AND rs.state_key = ${userId}
    `),
  );
}

export async function isUserJoinedToAllowedRoom(
  db: D1Database,
  roomId: string,
  userId: string,
): Promise<boolean> {
  const row = await executeKyselyQueryFirst<{ membership: string }>(
    db,
    asCompiledQuery(sql<{ membership: string }>`
      SELECT membership
      FROM room_memberships
      WHERE room_id = ${roomId} AND user_id = ${userId}
    `),
  );
  return row?.membership === "join";
}

export function getFederationLatestEvent(
  db: D1Database,
  roomId: string,
): Promise<FederationLatestEventRef | null> {
  return executeKyselyQueryFirst<FederationLatestEventRef>(
    db,
    asCompiledQuery(sql<FederationLatestEventRef>`
      SELECT event_id AS eventId, depth
      FROM events
      WHERE room_id = ${roomId}
      ORDER BY depth DESC
      LIMIT 1
    `),
  );
}

export async function federationEventExists(db: D1Database, eventId: string): Promise<boolean> {
  const row = await executeKyselyQueryFirst<{ event_id: string }>(
    db,
    asCompiledQuery(sql<{ event_id: string }>`
      SELECT event_id
      FROM events
      WHERE event_id = ${eventId}
    `),
  );
  return row !== null;
}

export async function federationLocalUserExists(db: D1Database, userId: string): Promise<boolean> {
  const row = await executeKyselyQueryFirst<{ user_id: string }>(
    db,
    asCompiledQuery(sql<{ user_id: string }>`
      SELECT user_id
      FROM users
      WHERE user_id = ${userId}
    `),
  );
  return row !== null;
}

export function getFederationThirdPartyInvite(
  db: D1Database,
  roomId: string,
  token: string,
): Promise<FederationThirdPartyInviteRecord | null> {
  return executeKyselyQueryFirst<FederationThirdPartyInviteRecord>(
    db,
    asCompiledQuery(sql<FederationThirdPartyInviteRecord>`
      SELECT e.event_id AS eventId, e.content, e.sender, e.state_key AS stateKey
      FROM room_state rs
      JOIN events e ON rs.event_id = e.event_id
      WHERE rs.room_id = ${roomId}
        AND rs.event_type = 'm.room.third_party_invite'
        AND rs.state_key = ${token}
    `),
  );
}

export function getFederationSenderMembershipEventId(
  db: D1Database,
  roomId: string,
  userId: string,
): Promise<string | null> {
  return executeKyselyQueryFirst<{ eventId: string }>(
    db,
    asCompiledQuery(sql<{ eventId: string }>`
      SELECT e.event_id AS eventId
      FROM room_state rs
      JOIN events e ON rs.event_id = e.event_id
      WHERE rs.room_id = ${roomId}
        AND rs.event_type = 'm.room.member'
        AND rs.state_key = ${userId}
    `),
  ).then((row) => row?.eventId ?? null);
}

export function listFederationStrippedStateEvents(
  db: D1Database,
  roomId: string,
  eventType: string,
): Promise<FederationStrippedStateEvent[]> {
  return executeKyselyQuery<FederationStrippedStateEvent>(
    db,
    asCompiledQuery(sql<FederationStrippedStateEvent>`
      SELECT e.event_type AS type, e.state_key, e.content, e.sender
      FROM room_state rs
      JOIN events e ON rs.event_id = e.event_id
      WHERE rs.room_id = ${roomId}
        AND rs.event_type = ${eventType}
    `),
  );
}

export function getFederationFullCreateEvent(
  db: D1Database,
  roomId: string,
): Promise<FederationFullCreateEvent | null> {
  return executeKyselyQueryFirst<FederationFullCreateEvent>(
    db,
    asCompiledQuery(sql<FederationFullCreateEvent>`
      SELECT e.event_id, e.room_id, e.event_type, e.state_key, e.content,
             e.sender, e.origin_server_ts, e.depth, e.auth_events, e.prev_events,
             e.hashes, e.signatures
      FROM room_state rs
      JOIN events e ON rs.event_id = e.event_id
      WHERE rs.room_id = ${roomId}
        AND rs.event_type = 'm.room.create'
    `),
  );
}

export function deleteFederationThirdPartyInviteState(
  db: D1Database,
  roomId: string,
  token: string,
): Promise<void> {
  return executeKyselyRun(
    db,
    asCompiledQuery(sql`
      DELETE FROM room_state
      WHERE room_id = ${roomId}
        AND event_type = 'm.room.third_party_invite'
        AND state_key = ${token}
    `),
  );
}
