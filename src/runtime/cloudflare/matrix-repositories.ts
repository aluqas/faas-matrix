import { discoverServer } from "../../services/server-discovery";
import { EFFECTIVE_MEMBERSHIPS_AND_JOINED_MEMBERS_CTE } from "../../matrix/repositories/membership-repository";
import { upsertPresence as dbUpsertPresence } from "../../matrix/repositories/presence-repository";
import {
  createRoom,
  createRoomAlias,
  ensureUserStub,
  getEvent,
  getEventsSince,
  getInviteStrippedState,
  getLatestForwardExtremities,
  getLatestRoomEventsByDepth,
  getLatestStreamPosition,
  getMembership,
  getRoom,
  getRoomByAlias,
  getRoomState,
  getStateEvent,
  getUserRooms,
  notifyUsersOfEvent,
  storeEvent,
  updateMembership,
} from "../../services/database";
import {
  getGlobalAccountData,
  getRoomAccountData,
} from "../../matrix/repositories/account-data-repository";
import { getReceiptsForRoom } from "../../api/receipts";
import { getToDeviceMessages } from "../../api/to-device";
import { getTypingUsers } from "../../api/typing";
import { countUnreadNotificationSummaryWithRules } from "../../services/push-rule-evaluator";
import type { Env, PDU, Room } from "../../types";
import type {
  FederationProcessedPdu,
  FederationRepository,
  FilterDefinition,
  ReceiptEvent,
  RoomRepository,
  SyncRepository,
} from "../../matrix/repositories/interfaces";
import { validateUrl } from "../../utils/url-validator";
import type {
  DeliveryQueue,
  DiscoveryService,
  RemoteKeyCache,
  SignedTransport,
} from "../../fedcore/contracts";
import { persistFederationMembershipEvent } from "../../matrix/application/federation-handler-service";

function parseJsonWithFallback<T>(value: string | null | undefined, fallback: T): T {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

async function getNextStreamPosition(db: D1Database, streamName: string): Promise<number> {
  await db
    .prepare(
      `
      UPDATE stream_positions SET position = position + 1 WHERE stream_name = ?
    `,
    )
    .bind(streamName)
    .run();

  const result = await db
    .prepare(
      `
      SELECT position FROM stream_positions WHERE stream_name = ?
    `,
    )
    .bind(streamName)
    .first<{ position: number }>();

  return result?.position ?? 1;
}

export class CloudflareRoomRepository implements RoomRepository {
  constructor(private readonly env: Env) {}

  getRoomByAlias(alias: string): Promise<string | null> {
    return getRoomByAlias(this.env.DB, alias);
  }

  createRoom(
    roomId: string,
    roomVersion: string,
    creatorId: string,
    isPublic: boolean,
  ): Promise<void> {
    return createRoom(this.env.DB, roomId, roomVersion, creatorId, isPublic);
  }

  createRoomAlias(alias: string, roomId: string, creatorId: string): Promise<void> {
    return createRoomAlias(this.env.DB, alias, roomId, creatorId);
  }

  async upsertRoomAccountData(
    userId: string,
    roomId: string,
    eventType: string,
    content: Record<string, unknown>,
  ): Promise<void> {
    await this.env.DB.prepare(
      `INSERT INTO account_data (user_id, room_id, event_type, content)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id, room_id, event_type) DO UPDATE SET content = excluded.content`,
    )
      .bind(userId, roomId, eventType, JSON.stringify(content))
      .run();
  }

  storeEvent(event: PDU): Promise<void> {
    return storeEvent(this.env.DB, event).then(() => undefined);
  }

  persistMembershipEvent(
    roomId: string,
    event: PDU,
    source: "client" | "federation" | "workflow",
  ): Promise<void> {
    return persistFederationMembershipEvent(this.env.DB, {
      roomId,
      event,
      source,
    });
  }

  updateMembership(
    roomId: string,
    userId: string,
    membership: "join" | "invite" | "leave" | "ban" | "knock",
    eventId: string,
    displayName?: string,
    avatarUrl?: string,
  ): Promise<void> {
    return updateMembership(
      this.env.DB,
      roomId,
      userId,
      membership,
      eventId,
      displayName,
      avatarUrl,
    );
  }

  notifyUsersOfEvent(roomId: string, eventId: string, eventType: string): Promise<void> {
    return notifyUsersOfEvent(this.env, roomId, eventId, eventType);
  }

  getRoom(roomId: string): Promise<Room | null> {
    return getRoom(this.env.DB, roomId);
  }

  getEvent(eventId: string): Promise<PDU | null> {
    return getEvent(this.env.DB, eventId);
  }

  getMembership(roomId: string, userId: string) {
    return getMembership(this.env.DB, roomId, userId);
  }

  getStateEvent(roomId: string, eventType: string, stateKey?: string) {
    return getStateEvent(this.env.DB, roomId, eventType, stateKey);
  }

  async getLatestRoomEvents(roomId: string, limit: number): Promise<PDU[]> {
    return getLatestRoomEventsByDepth(this.env.DB, roomId, limit);
  }
}

export class CloudflareSyncRepository implements SyncRepository {
  constructor(private readonly env: Env) {}

  async loadFilter(userId: string, filterParam?: string): Promise<FilterDefinition | null> {
    if (!filterParam) return null;
    if (filterParam.startsWith("{")) {
      try {
        return parseJsonWithFallback<FilterDefinition | null>(filterParam, null);
      } catch {
        return null;
      }
    }

    const filterJson = await this.env.CACHE.get(`filter:${userId}:${filterParam}`);
    if (!filterJson) return null;

    try {
      return parseJsonWithFallback<FilterDefinition | null>(filterJson, null);
    } catch {
      return null;
    }
  }

  getLatestStreamPosition(): Promise<number> {
    return getLatestStreamPosition(this.env.DB);
  }

  async getLatestDeviceKeyPosition(): Promise<number> {
    const result = await this.env.DB.prepare(
      `SELECT position FROM stream_positions WHERE stream_name = 'device_keys'`,
    ).first<{ position: number }>();
    return result?.position ?? 0;
  }

  getToDeviceMessages(userId: string, deviceId: string, since: string) {
    return getToDeviceMessages(this.env.DB, userId, deviceId, since);
  }

  async getOneTimeKeyCounts(userId: string, deviceId: string): Promise<Record<string, number>> {
    const counts = await this.env.DB.prepare(`
      SELECT algorithm, COUNT(*) as count
      FROM one_time_keys
      WHERE user_id = ? AND device_id = ? AND claimed = 0
      GROUP BY algorithm
    `)
      .bind(userId, deviceId)
      .all<{ algorithm: string; count: number }>();

    const result: Record<string, number> = {};
    for (const row of counts.results) {
      result[row.algorithm] = row.count;
    }
    return result;
  }

  async getUnusedFallbackKeyTypes(userId: string, deviceId: string): Promise<string[]> {
    const keys = await this.env.DB.prepare(`
      SELECT DISTINCT algorithm
      FROM fallback_keys
      WHERE user_id = ? AND device_id = ? AND used = 0
    `)
      .bind(userId, deviceId)
      .all<{ algorithm: string }>();
    return keys.results.map((row) => row.algorithm);
  }

  async getDeviceListChanges(
    userId: string,
    sinceEventPosition: number,
    sinceDeviceKeyPosition: number,
  ): Promise<{ changed: string[]; left: string[] }> {
    const effCte = EFFECTIVE_MEMBERSHIPS_AND_JOINED_MEMBERS_CTE.trim();
    const [localChanged, remoteChanged, newlyShared, currentMembersInJoinedRooms, noLongerShared] =
      await Promise.all([
        this.env.DB.prepare(`
        SELECT DISTINCT dkc.user_id
        FROM device_key_changes dkc
        WHERE dkc.stream_position > ?
          AND (
            dkc.user_id = ?
            OR EXISTS (
              WITH ${effCte}
              SELECT 1
              FROM joined_members j1
              JOIN joined_members j2 ON j1.room_id = j2.room_id
              WHERE j1.user_id = ? AND j2.user_id = dkc.user_id
            )
          )
      `)
          .bind(sinceDeviceKeyPosition, userId, userId)
          .all<{ user_id: string }>(),
        this.env.DB.prepare(`
        SELECT DISTINCT rdls.user_id
        FROM remote_device_list_streams rdls
        WHERE rdls.stream_id > ?
          AND EXISTS (
            WITH ${effCte},
            requester_joined_rooms AS (
              SELECT room_id
              FROM joined_members
              WHERE user_id = ?
            )
            SELECT 1
            FROM requester_joined_rooms jr
            JOIN joined_members jm ON jr.room_id = jm.room_id
            WHERE jm.user_id = rdls.user_id
          )
      `)
          .bind(sinceDeviceKeyPosition, userId)
          .all<{ user_id: string }>(),
        this.env.DB.prepare(`
        WITH ${effCte}
        SELECT DISTINCT e.state_key as user_id
        FROM events e
        JOIN joined_members requester_j
          ON requester_j.room_id = e.room_id AND requester_j.user_id = ?
        JOIN joined_members target_j
          ON target_j.room_id = e.room_id AND target_j.user_id = e.state_key
        WHERE e.event_type = 'm.room.member'
          AND e.stream_ordering > ?
          AND e.state_key IS NOT NULL
          AND e.state_key != ?
          AND json_extract(e.content, '$.membership') = 'join'
          AND NOT EXISTS (
            SELECT 1
            FROM joined_members sr
            JOIN joined_members st ON sr.room_id = st.room_id
            WHERE sr.user_id = ?
              AND st.user_id = e.state_key
              AND sr.room_id != e.room_id
          )
        `)
          .bind(userId, sinceEventPosition, userId, userId)
          .all<{ user_id: string }>(),
        this.env.DB.prepare(`
        WITH ${effCte}
        SELECT DISTINCT joined_members.user_id
        FROM events requester_join_event
        JOIN joined_members
          ON joined_members.room_id = requester_join_event.room_id
        WHERE requester_join_event.event_type = 'm.room.member'
          AND requester_join_event.stream_ordering > ?
          AND requester_join_event.state_key = ?
          AND json_extract(requester_join_event.content, '$.membership') = 'join'
      `)
          .bind(sinceEventPosition, userId)
          .all<{ user_id: string }>(),
        this.env.DB.prepare(`
        WITH ${effCte},
        non_join_members AS (
          SELECT room_id, user_id
          FROM current_memberships
          WHERE membership IN ('leave', 'ban')
        )
        SELECT DISTINCT left_user_id as user_id
        FROM (
          SELECT e.state_key as left_user_id
          FROM events e
          JOIN joined_members requester_j
            ON requester_j.room_id = e.room_id AND requester_j.user_id = ?
          WHERE e.event_type = 'm.room.member'
            AND e.stream_ordering > ?
            AND e.state_key IS NOT NULL
            AND e.state_key != ?
            AND json_extract(e.content, '$.membership') IN ('leave', 'ban')
            AND NOT EXISTS (
              SELECT 1
              FROM joined_members sr
              JOIN joined_members st ON sr.room_id = st.room_id
              WHERE sr.user_id = ?
                AND st.user_id = e.state_key
                AND sr.room_id != e.room_id
            )

          UNION

          SELECT other_j.user_id as left_user_id
          FROM events e
          JOIN non_join_members requester_nj
            ON requester_nj.room_id = e.room_id AND requester_nj.user_id = ?
          JOIN joined_members other_j
            ON other_j.room_id = e.room_id
          WHERE e.event_type = 'm.room.member'
            AND e.stream_ordering > ?
            AND e.state_key = ?
            AND other_j.user_id != ?
            AND json_extract(e.content, '$.membership') IN ('leave', 'ban')
            AND NOT EXISTS (
              SELECT 1
              FROM joined_members sr
              JOIN joined_members st ON sr.room_id = st.room_id
              WHERE sr.user_id = ?
                AND st.user_id = other_j.user_id
            )
        )
      `)
          .bind(
            userId,
            sinceEventPosition,
            userId,
            userId,
            userId,
            sinceEventPosition,
            userId,
            userId,
            userId,
          )
          .all<{ user_id: string }>(),
      ]);

    const changed = new Set<string>();
    const left = new Set<string>();

    for (const row of localChanged.results) {
      changed.add(row.user_id);
    }
    for (const row of remoteChanged.results) {
      changed.add(row.user_id);
    }
    for (const row of newlyShared.results) {
      changed.add(row.user_id);
    }
    for (const row of currentMembersInJoinedRooms.results) {
      changed.add(row.user_id);
    }
    for (const row of noLongerShared.results) {
      if (!changed.has(row.user_id)) {
        left.add(row.user_id);
      }
    }

    return {
      changed: [...changed],
      left: [...left],
    };
  }

  getGlobalAccountData(userId: string, since?: number) {
    return getGlobalAccountData(this.env.DB, userId, since);
  }

  getRoomAccountData(userId: string, roomId: string, since?: number) {
    return getRoomAccountData(this.env.DB, userId, roomId, since);
  }

  getUserRooms(userId: string, membership?: "join" | "invite" | "leave" | "ban" | "knock") {
    return getUserRooms(this.env.DB, userId, membership);
  }

  getMembership(roomId: string, userId: string) {
    return getMembership(this.env.DB, roomId, userId);
  }

  getEventsSince(roomId: string, sincePosition: number) {
    return getEventsSince(this.env.DB, roomId, sincePosition);
  }

  getEvent(eventId: string) {
    return getEvent(this.env.DB, eventId);
  }

  getRoomState(roomId: string) {
    return getRoomState(this.env.DB, roomId);
  }

  getInviteStrippedState(roomId: string) {
    return getInviteStrippedState(this.env.DB, roomId);
  }

  getReceiptsForRoom(roomId: string, userId: string): Promise<ReceiptEvent> {
    return getReceiptsForRoom(this.env, roomId, userId) as Promise<ReceiptEvent>;
  }

  async getUnreadNotificationSummary(roomId: string, userId: string) {
    const receipts = await getReceiptsForRoom(this.env, roomId, userId);
    return countUnreadNotificationSummaryWithRules(this.env.DB, userId, roomId, receipts.content);
  }

  getTypingUsers(roomId: string): Promise<string[]> {
    return getTypingUsers(this.env, roomId);
  }

  async waitForUserEvents(userId: string, timeoutMs: number): Promise<{ hasEvents: boolean }> {
    const syncDO = this.env.SYNC;
    const doId = syncDO.idFromName(userId);
    const stub = syncDO.get(doId);
    const response = await stub.fetch(
      new Request("http://internal/wait-for-events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timeout: timeoutMs }),
      }),
    );
    return response.json() as Promise<{ hasEvents: boolean }>;
  }
}

export class CloudflareFederationRepository implements FederationRepository {
  constructor(private readonly env: Env) {}

  async getCachedTransaction(
    origin: string,
    txnId: string,
  ): Promise<Record<string, unknown> | null> {
    const result = await this.env.DB.prepare(
      `SELECT response FROM federation_transactions WHERE origin = ? AND txn_id = ?`,
    )
      .bind(origin, txnId)
      .first<{ response: string | null }>();

    return result?.response
      ? parseJsonWithFallback<Record<string, unknown> | null>(result.response, null)
      : null;
  }

  async storeCachedTransaction(
    origin: string,
    txnId: string,
    response: Record<string, unknown>,
  ): Promise<void> {
    await this.env.DB.prepare(
      `INSERT OR REPLACE INTO federation_transactions (txn_id, origin, received_at, response)
       VALUES (?, ?, ?, ?)`,
    )
      .bind(txnId, origin, Date.now(), JSON.stringify(response))
      .run();
  }

  async getProcessedPdu(eventId: string): Promise<FederationProcessedPdu | null> {
    const result = await this.env.DB.prepare(
      `SELECT accepted, rejection_reason FROM processed_pdus WHERE event_id = ?`,
    )
      .bind(eventId)
      .first<{ accepted: number; rejection_reason: string | null }>();

    if (!result) return null;
    return {
      accepted: result.accepted === 1,
      rejectionReason: result.rejection_reason,
    };
  }

  async recordProcessedPdu(
    eventId: string,
    origin: string,
    roomId: string,
    accepted: boolean,
    rejectionReason?: string,
  ): Promise<void> {
    await this.env.DB.prepare(
      `INSERT OR REPLACE INTO processed_pdus (event_id, origin, room_id, processed_at, accepted, rejection_reason)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(eventId, origin, roomId, Date.now(), accepted ? 1 : 0, rejectionReason || null)
      .run();
  }

  createRoom(
    roomId: string,
    roomVersion: string,
    creatorId: string,
    isPublic: boolean,
  ): Promise<void> {
    return createRoom(this.env.DB, roomId, roomVersion, creatorId, isPublic);
  }

  getRoom(roomId: string): Promise<Room | null> {
    return getRoom(this.env.DB, roomId);
  }

  getEvent(eventId: string) {
    return getEvent(this.env.DB, eventId);
  }

  async getLatestRoomEvents(roomId: string, limit: number): Promise<PDU[]> {
    return getLatestForwardExtremities(this.env.DB, roomId, limit);
  }

  getRoomState(roomId: string): Promise<PDU[]> {
    return getRoomState(this.env.DB, roomId);
  }

  getInviteStrippedState(roomId: string) {
    return getInviteStrippedState(this.env.DB, roomId);
  }

  async storeIncomingEvent(event: PDU): Promise<void> {
    await storeEvent(this.env.DB, event);
  }

  notifyUsersOfEvent(roomId: string, eventId: string, eventType: string): Promise<void> {
    return notifyUsersOfEvent(this.env, roomId, eventId, eventType);
  }

  updateMembership(
    roomId: string,
    userId: string,
    membership: "join" | "invite" | "leave" | "ban" | "knock",
    eventId: string,
    displayName?: string,
    avatarUrl?: string,
  ): Promise<void> {
    return updateMembership(
      this.env.DB,
      roomId,
      userId,
      membership,
      eventId,
      displayName,
      avatarUrl,
    );
  }

  async upsertRoomState(
    roomId: string,
    eventType: string,
    stateKey: string,
    eventId: string,
  ): Promise<void> {
    await this.env.DB.prepare(
      `INSERT OR REPLACE INTO room_state (room_id, event_type, state_key, event_id)
       VALUES (?, ?, ?, ?)`,
    )
      .bind(roomId, eventType, stateKey, eventId)
      .run();
  }

  async storeProcessedEdu(
    origin: string,
    eduType: string,
    content: Record<string, unknown>,
  ): Promise<void> {
    await this.env.DB.prepare(
      `INSERT OR REPLACE INTO processed_edus (edu_id, edu_type, origin, processed_at, content)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(String(content["edu_id"] || ""), eduType, origin, Date.now(), JSON.stringify(content))
      .run();
  }

  async upsertPresence(
    userId: string,
    presence: string,
    statusMessage: string | null,
    lastActiveTs: number,
    currentlyActive: boolean,
  ): Promise<void> {
    await ensureUserStub(this.env.DB, userId);
    await dbUpsertPresence(
      this.env.DB,
      userId,
      presence,
      statusMessage,
      lastActiveTs,
      currentlyActive,
    );
  }

  async upsertRemoteDeviceList(
    userId: string,
    deviceId: string,
    streamId: number,
    keys: Record<string, unknown> | null,
    displayName?: string,
    deleted?: boolean,
  ): Promise<void> {
    const localStreamPosition = await getNextStreamPosition(this.env.DB, "device_keys");

    if (deleted) {
      await this.env.DB.prepare(
        `DELETE FROM remote_device_lists WHERE user_id = ? AND device_id = ?`,
      )
        .bind(userId, deviceId)
        .run();
    } else {
      await this.env.DB.prepare(`
        INSERT INTO remote_device_lists (user_id, device_id, device_display_name, keys, stream_id, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (user_id, device_id) DO UPDATE SET
          device_display_name = excluded.device_display_name,
          keys = excluded.keys,
          stream_id = excluded.stream_id,
          updated_at = excluded.updated_at
      `)
        .bind(
          userId,
          deviceId,
          displayName || null,
          keys ? JSON.stringify(keys) : null,
          streamId,
          Date.now(),
        )
        .run();
    }

    await this.env.DB.prepare(`
      INSERT INTO remote_device_list_streams (user_id, stream_id, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT (user_id) DO UPDATE SET
        stream_id = MAX(remote_device_list_streams.stream_id, excluded.stream_id),
        updated_at = excluded.updated_at
    `)
      .bind(userId, localStreamPosition, Date.now())
      .run();
  }
}

export class CloudflareSignedTransport implements SignedTransport {
  async verifyJson(): Promise<boolean> {
    return false;
  }
}

export class CloudflareDiscoveryService implements DiscoveryService<{
  host: string;
  port: number;
  tlsHostname: string;
}> {
  constructor(private readonly env: Env) {}

  discover(serverName: string) {
    return discoverServer(serverName, this.env.CACHE);
  }
}

export class CloudflareDeliveryQueue implements DeliveryQueue<Record<string, unknown>> {
  async enqueue(): Promise<void> {}
}

export class CloudflareRemoteKeyCache implements RemoteKeyCache<{ keyId: string; key: string }> {
  constructor(private readonly env: Env) {}

  async get(serverName: string, keyId: string): Promise<{ keyId: string; key: string } | null> {
    const raw = await this.env.CACHE.get(`fedkey:${serverName}:${keyId}`);
    if (!raw) return null;
    return parseJsonWithFallback<{ keyId: string; key: string } | null>(raw, null);
  }

  async put(serverName: string, keyId: string, key: { keyId: string; key: string }): Promise<void> {
    await this.env.CACHE.put(`fedkey:${serverName}:${keyId}`, JSON.stringify(key), {
      expirationTtl: 3600,
    });
  }
}

export function assertValidMatrixServerUrl(url: string): void {
  const validation = validateUrl(url);
  if (!validation.valid) {
    throw new Error(validation.error || "Invalid URL");
  }
}
