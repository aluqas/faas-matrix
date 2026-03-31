import { discoverServer } from "../../services/server-discovery";
import {
  createRoom,
  createRoomAlias,
  ensureUserStub,
  getEvent,
  getEventsSince,
  getInviteStrippedState,
  getLatestStreamPosition,
  getMembership,
  getRoom,
  getRoomByAlias,
  getRoomEvents,
  getRoomState,
  getStateEvent,
  getUserRooms,
  notifyUsersOfEvent,
  storeEvent,
  updateMembership,
} from "../../services/database";
import { getGlobalAccountData, getRoomAccountData } from "../../api/account-data";
import { getReceiptsForRoom } from "../../api/receipts";
import { getToDeviceMessages } from "../../api/to-device";
import { getTypingUsers } from "../../api/typing";
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

  getMembership(roomId: string, userId: string) {
    return getMembership(this.env.DB, roomId, userId);
  }

  getStateEvent(roomId: string, eventType: string, stateKey?: string) {
    return getStateEvent(this.env.DB, roomId, eventType, stateKey);
  }

  async getLatestRoomEvents(roomId: string, limit: number): Promise<PDU[]> {
    const result = await getRoomEvents(this.env.DB, roomId, undefined, limit);
    return result.events;
  }
}

export class CloudflareSyncRepository implements SyncRepository {
  constructor(private readonly env: Env) {}

  async loadFilter(userId: string, filterParam?: string): Promise<FilterDefinition | null> {
    if (!filterParam) return null;
    if (filterParam.startsWith("{")) {
      try {
        return JSON.parse(filterParam) as FilterDefinition;
      } catch {
        return null;
      }
    }

    const filterJson = await this.env.CACHE.get(`filter:${userId}:${filterParam}`);
    if (!filterJson) return null;

    try {
      return JSON.parse(filterJson) as FilterDefinition;
    } catch {
      return null;
    }
  }

  getLatestStreamPosition(): Promise<number> {
    return getLatestStreamPosition(this.env.DB);
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
    sincePosition: number,
  ): Promise<{ changed: string[]; left: string[] }> {
    const changed = await this.env.DB.prepare(`
      SELECT DISTINCT user_id
      FROM remote_device_list_streams
      WHERE updated_at > ?
        AND user_id IN (
          SELECT DISTINCT rm2.user_id
          FROM room_memberships rm1
          JOIN room_memberships rm2 ON rm1.room_id = rm2.room_id
          WHERE rm1.user_id = ?
            AND rm1.membership = 'join'
            AND rm2.membership = 'join'
            AND rm2.user_id != ?
        )
    `)
      .bind(sincePosition, userId, userId)
      .all<{ user_id: string }>();

    return {
      changed: changed.results.map((row) => row.user_id),
      left: [],
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

    return result?.response ? JSON.parse(result.response) : null;
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

  getRoomState(roomId: string): Promise<PDU[]> {
    return getRoomState(this.env.DB, roomId);
  }

  getInviteStrippedState(roomId: string) {
    return getInviteStrippedState(this.env.DB, roomId);
  }

  async storeIncomingEvent(event: PDU): Promise<void> {
    const existing = await this.env.DB.prepare(`SELECT event_id FROM events WHERE event_id = ?`)
      .bind(event.event_id)
      .first();
    if (existing) return;

    const lastOrdering = await this.env.DB.prepare(
      `SELECT MAX(stream_ordering) as max_ordering FROM events`,
    ).first<{ max_ordering: number | null }>();
    const streamOrdering = (lastOrdering?.max_ordering ?? 0) + 1;

    await this.env.DB.prepare(
      `INSERT OR IGNORE INTO events
       (event_id, room_id, sender, event_type, state_key, content, origin_server_ts, unsigned, depth, auth_events, prev_events, hashes, signatures, stream_ordering)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        event.event_id,
        event.room_id,
        event.sender,
        event.type,
        event.state_key ?? null,
        JSON.stringify(event.content),
        event.origin_server_ts,
        event.unsigned ? JSON.stringify(event.unsigned) : null,
        event.depth || 0,
        JSON.stringify(event.auth_events || []),
        JSON.stringify(event.prev_events || []),
        event.hashes ? JSON.stringify(event.hashes) : null,
        event.signatures ? JSON.stringify(event.signatures) : null,
        streamOrdering,
      )
      .run();
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
      .bind(String(content.edu_id || ""), eduType, origin, Date.now(), JSON.stringify(content))
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
    await this.env.DB.prepare(`
      INSERT INTO presence (user_id, presence, status_msg, last_active_ts, currently_active)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (user_id) DO UPDATE SET
        presence = excluded.presence,
        status_msg = excluded.status_msg,
        last_active_ts = excluded.last_active_ts,
        currently_active = excluded.currently_active
    `)
      .bind(userId, presence, statusMessage, lastActiveTs, currentlyActive ? 1 : 0)
      .run();
  }

  async upsertRemoteDeviceList(
    userId: string,
    deviceId: string,
    streamId: number,
    keys: Record<string, unknown> | null,
    displayName?: string,
    deleted?: boolean,
  ): Promise<void> {
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
      .bind(userId, streamId, Date.now())
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
    return JSON.parse(raw) as { keyId: string; key: string };
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
