/**
 * Shared extension builder for MSC3575 and MSC4186 Sliding Sync.
 *
 * Both sliding-sync variants request the same set of extensions
 * (to_device, e2ee, account_data, typing, receipts, presence, MSC4308).
 * This module owns the shared logic so the two handlers don't drift apart.
 */

import type { SlidingSyncExtensionContext, SlidingSyncExtensionOutput } from "../types/sync";
import type { SlidingSyncExtensionConfig } from "../types/client";
import type { AccountDataEvent } from "../types";

import { projectPresenceEvents } from "../matrix/application/features/presence/project";
import { getE2EEAccountDataFromDO } from "../matrix/application/features/account-data/effect-adapters";
import { projectDeviceLists } from "../matrix/application/sync-projection";
import { CloudflareSyncRepository } from "../runtime/cloudflare/matrix-repositories";
import { getThreadSubscriptionsExtension } from "../matrix/application/features/sync/thread-subscriptions";
import { getTypingForRooms } from "./typing";
import { getReceiptsForRooms } from "./receipts";

const THREAD_SUBSCRIPTIONS_EVENT_TYPE = "io.element.msc4306.thread_subscriptions";

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export type { SlidingSyncExtensionConfig, SlidingSyncExtensionContext, SlidingSyncExtensionOutput };

function ensureRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// ---------------------------------------------------------------------------
// Main builder
// ---------------------------------------------------------------------------

/**
 * Build all requested sliding-sync extensions.
 *
 * Each extension is only populated when its key is present in `config`.
 * Callers can override which extensions are requested to add Route-level
 * compatibility quirks (e.g. MSC4186 forces typing even when not requested).
 */
export async function buildSlidingSyncExtensions(
  ctx: SlidingSyncExtensionContext,
  config: SlidingSyncExtensionConfig,
): Promise<SlidingSyncExtensionOutput> {
  const { userId, deviceId, db, env, sincePos, isInitialSync, responseRoomIds, subscribedRoomIds } =
    ctx;
  const allJoinedRoomIds = ctx.visibilityContext.visibleJoinedRoomIds;
  const output: SlidingSyncExtensionOutput = {};

  // ── to_device ─────────────────────────────────────────────────────────────
  if (config.to_device) {
    const limit = config.to_device.limit ?? 100;
    const { getToDeviceMessages } = await import("./to-device");
    const { events, nextBatch } = await getToDeviceMessages(
      db,
      userId,
      deviceId ?? "",
      config.to_device.since,
      limit,
    );
    output.to_device = { next_batch: nextBatch, events };
  }

  // ── e2ee ──────────────────────────────────────────────────────────────────
  if (config.e2ee) {
    const syncRepository = new CloudflareSyncRepository(env);
    const keyCounts = deviceId ? await syncRepository.getOneTimeKeyCounts(userId, deviceId) : {};
    const unusedFallbackTypes = deviceId
      ? await syncRepository.getUnusedFallbackKeyTypes(userId, deviceId)
      : [];
    const deviceLists = await projectDeviceLists(syncRepository, {
      userId,
      isInitialSync,
      sinceEventPosition: sincePos,
      sinceDeviceKeyPosition: sincePos,
    });
    output.e2ee = {
      device_lists: deviceLists ?? { changed: [], left: [] },
      device_one_time_keys_count: keyCounts,
      device_unused_fallback_key_types: unusedFallbackTypes,
    };
  }

  // ── account_data ──────────────────────────────────────────────────────────
  if (config.account_data) {
    const globalData = await db
      .prepare(`SELECT event_type, content FROM account_data WHERE user_id = ? AND room_id = ''`)
      .bind(userId)
      .all();

    const globalAccountData: Record<string, Record<string, unknown>> = {};
    for (const d of globalData.results as { event_type: string; content: string }[]) {
      try {
        globalAccountData[d.event_type] = ensureRecord(JSON.parse(d.content) as unknown);
      } catch {
        globalAccountData[d.event_type] = {};
      }
    }

    // E2EE account data must come from DO for strong consistency (SSSS / cross-signing keys).
    try {
      const e2eeData = await getE2EEAccountDataFromDO(env, userId);
      for (const [eventType, content] of Object.entries(e2eeData ?? {})) {
        globalAccountData[eventType] = ensureRecord(content);
      }
    } catch (err) {
      console.error("[sliding-sync-extensions] Failed to get E2EE account data from DO:", err);
    }

    const accountDataRooms: Record<string, AccountDataEvent[]> = {};
    // Client-specified rooms take precedence; fall back to all joined rooms for completeness.
    const roomsForAccountData = config.account_data.rooms ?? allJoinedRoomIds;
    for (const roomId of roomsForAccountData) {
      const roomData = await db
        .prepare(`SELECT event_type, content FROM account_data WHERE user_id = ? AND room_id = ?`)
        .bind(userId, roomId)
        .all<{ event_type: string; content: string }>();
      if (roomData.results.length > 0) {
        accountDataRooms[roomId] = roomData.results.map((d) => {
          try {
            return { type: d.event_type, content: ensureRecord(JSON.parse(d.content) as unknown) };
          } catch {
            return { type: d.event_type, content: {} };
          }
        });
      }
    }

    output.account_data = {
      global: Object.entries(globalAccountData).map(([type, content]) => ({ type, content })),
      rooms: accountDataRooms,
    };
  }

  // ── typing ────────────────────────────────────────────────────────────────
  if (config.typing) {
    const roomIds = resolveEphemeralRoomIds(responseRoomIds, subscribedRoomIds, allJoinedRoomIds);
    if (roomIds.length > 0) {
      const typingByRoom = await getTypingForRooms(env, roomIds);
      output.typing = {
        rooms: Object.fromEntries(
          roomIds.map((roomId) => [
            roomId,
            { type: "m.typing", content: { user_ids: typingByRoom[roomId] ?? [] } },
          ]),
        ),
      };
    }
  }

  // ── receipts ──────────────────────────────────────────────────────────────
  if (config.receipts) {
    const roomIds = resolveEphemeralRoomIds(responseRoomIds, subscribedRoomIds, allJoinedRoomIds);
    if (roomIds.length > 0) {
      const receiptsByRoom = await getReceiptsForRooms(env, roomIds, userId);
      output.receipts = {
        rooms: Object.fromEntries(
          Object.entries(receiptsByRoom).map(([roomId, content]) => [
            roomId,
            { type: "m.receipt", content },
          ]),
        ),
      };
    } else {
      output.receipts = { rooms: {} };
    }
  }

  // ── presence ─────────────────────────────────────────────────────────────
  // Use allJoinedRoomIds (not responseRoomIds) to match the canonical /sync behaviour:
  // presence should reflect all rooms the user shares with others, not just the
  // current sliding window.
  if (config.presence) {
    const presenceRoomIds = allJoinedRoomIds.length > 0 ? allJoinedRoomIds : responseRoomIds;
    const presenceProjection =
      presenceRoomIds.length > 0
        ? await projectPresenceEvents(db, (env as { CACHE?: KVNamespace }).CACHE, {
            userId,
            visibleRoomIds: presenceRoomIds,
          })
        : { events: [] };
    output.presence = { events: presenceProjection.events };
  }

  // ── MSC4308 thread subscriptions ─────────────────────────────────────────
  // Room scope: prefer client-requested rooms; fall back to allJoinedRoomIds so
  // the query covers the same visibility scope as the other extensions.
  const threadConfig = (config as Record<string, unknown>)[
    "io.element.msc4308.thread_subscriptions"
  ] as { rooms?: string[] } | undefined;
  if (threadConfig) {
    const threadRoomIds =
      threadConfig.rooms && threadConfig.rooms.length > 0
        ? threadConfig.rooms
        : allJoinedRoomIds.length > 0
          ? allJoinedRoomIds
          : undefined;
    const subscribed = await getThreadSubscriptionsExtension(
      db,
      userId,
      THREAD_SUBSCRIPTIONS_EVENT_TYPE,
      threadRoomIds,
    );
    if (subscribed) {
      output["io.element.msc4308.thread_subscriptions"] = { subscribed };
    }
  }

  return output;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Determine the set of room IDs that ephemeral projections (typing, receipts)
 * should cover.
 *
 * Prefers `responseRoomIds ∪ subscribedRoomIds` but falls back to
 * `allJoinedRoomIds` when the union is empty.  This matches Element X
 * behaviour where extension connections carry no room window of their own.
 */
export function resolveEphemeralRoomIds(
  responseRoomIds: string[],
  subscribedRoomIds: string[],
  allJoinedRoomIds: string[],
): string[] {
  const combined = [...new Set([...responseRoomIds, ...subscribedRoomIds])];
  return combined.length === 0 ? allJoinedRoomIds : combined;
}
