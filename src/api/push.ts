// Push Notifications API
// Implements: https://spec.matrix.org/v1.12/client-server-api/#push-notifications
//
// This module handles:
// - Pusher registration and management
// - Push rules (override, content, room, sender, underride)
// - Notification listing
//
// Push notifications allow users to receive alerts on mobile devices
// even when the app is not running.

import { Hono } from "hono";
import type { AppEnv } from "../shared/types";
import { isJsonObject } from "../shared/types/common";
import { Errors } from "../shared/utils/errors";
import { extractAccessToken, requireAuth } from "../infra/middleware/auth";
import { hashToken } from "../shared/utils/crypto";
import { runClientEffect } from "../matrix/application/runtime/effect-runtime";
import { withLogContext } from "../matrix/application/logging";
import { getAccessTokenRecordByHash } from "../infra/db/database";
import { notifySyncUser } from "../infra/realtime/sync-notify";
import {
  type JsonObject,
  type PusherData,
  type PushAction,
  type PushCondition,
  type PushEvaluationResult,
  type PushEvent,
  type PushNotificationCounts,
  type PushRule,
  parseJsonObject,
  parseJsonObjectString,
  parsePushActionsJson,
  parsePushConditionsJson,
  parsePusherDataJson,
  parsePusherRequestBody,
  parsePushRuleActionsRequest,
  parsePushRuleEnabledRequest,
  parsePushRuleUpsertRequest,
} from "./push-contracts";

const app = new Hono<AppEnv>();

function createPushLogger(operation: string, context: Record<string, unknown> = {}) {
  return withLogContext({
    component: "push",
    operation,
    debugEnabled: true,
    user_id: typeof context["user_id"] === "string" ? context["user_id"] : undefined,
    room_id: typeof context["room_id"] === "string" ? context["room_id"] : undefined,
    event_id: typeof context["event_id"] === "string" ? context["event_id"] : undefined,
  });
}

function getMxidLocalpart(userId: string): string {
  const [rawLocalpart = ""] = userId.split(":");
  return rawLocalpart.startsWith("@") ? rawLocalpart.slice(1) : rawLocalpart;
}

function cloneJsonObject(value: JsonObject | undefined): JsonObject {
  return value ? structuredClone(value) : {};
}

function toJsonCounts(counts: PushNotificationCounts): JsonObject {
  return {
    unread: counts.unread,
    ...(typeof counts.missed_calls === "number" ? { missed_calls: counts.missed_calls } : {}),
  };
}

function parseApnsGatewayResult(
  value: unknown,
): { success: boolean; apnsId?: string; error?: string } | null {
  if (!isJsonObject(value) || typeof value.success !== "boolean") {
    return null;
  }
  return {
    success: value.success,
    ...(typeof value.apnsId === "string" ? { apnsId: value.apnsId } : {}),
    ...(typeof value.error === "string" ? { error: value.error } : {}),
  };
}

function getNestedValue(obj: unknown, path: string): unknown {
  const keys = path.split(".");
  let value: unknown = obj;

  for (const key of keys) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }

    value = (value as Record<string, unknown>)[key];
  }

  return value;
}

// ============================================
// Default Push Rules
// ============================================

// Matrix spec defines default push rules that clients expect
const DEFAULT_OVERRIDE_RULES: PushRule[] = [
  {
    rule_id: ".m.rule.master",
    default: true,
    enabled: false,
    actions: ["dont_notify"],
  },
  {
    rule_id: ".m.rule.suppress_notices",
    default: true,
    enabled: true,
    conditions: [{ kind: "event_match", key: "content.msgtype", pattern: "m.notice" }],
    actions: ["dont_notify"],
  },
  {
    rule_id: ".m.rule.invite_for_me",
    default: true,
    enabled: true,
    conditions: [
      { kind: "event_match", key: "type", pattern: "m.room.member" },
      { kind: "event_match", key: "content.membership", pattern: "invite" },
      { kind: "event_match", key: "state_key", pattern: "" }, // Will be replaced with user_id
    ],
    actions: ["notify", { set_tweak: "sound", value: "default" }],
  },
  {
    rule_id: ".m.rule.member_event",
    default: true,
    enabled: true,
    conditions: [{ kind: "event_match", key: "type", pattern: "m.room.member" }],
    actions: ["dont_notify"],
  },
  {
    rule_id: ".m.rule.is_user_mention",
    default: true,
    enabled: true,
    conditions: [
      { kind: "event_property_contains", key: "content.m\\.mentions.user_ids", value: "" }, // user_id placeholder
    ],
    actions: [
      "notify",
      { set_tweak: "sound", value: "default" },
      { set_tweak: "highlight", value: true },
    ],
  },
  {
    rule_id: ".m.rule.contains_display_name",
    default: true,
    enabled: true,
    conditions: [{ kind: "contains_display_name" }],
    actions: [
      "notify",
      { set_tweak: "sound", value: "default" },
      { set_tweak: "highlight", value: true },
    ],
  },
  {
    rule_id: ".m.rule.is_room_mention",
    default: true,
    enabled: true,
    conditions: [
      { kind: "event_property_is", key: "content.m\\.mentions.room", value: true },
      { kind: "sender_notification_permission", key: "room" },
    ],
    actions: ["notify", { set_tweak: "highlight", value: true }],
  },
  {
    rule_id: ".m.rule.tombstone",
    default: true,
    enabled: true,
    conditions: [
      { kind: "event_match", key: "type", pattern: "m.room.tombstone" },
      { kind: "event_match", key: "state_key", pattern: "" },
    ],
    actions: ["notify", { set_tweak: "highlight", value: true }],
  },
  {
    rule_id: ".m.rule.room.server_acl",
    default: true,
    enabled: true,
    conditions: [
      { kind: "event_match", key: "type", pattern: "m.room.server_acl" },
      { kind: "event_match", key: "state_key", pattern: "" },
    ],
    actions: [],
  },
  {
    rule_id: ".org.matrix.msc3930.rule.poll_response",
    default: true,
    enabled: true,
    conditions: [{ kind: "event_match", key: "type", pattern: "org.matrix.msc3381.poll.response" }],
    actions: [],
  },
  {
    rule_id: ".m.rule.reaction",
    default: true,
    enabled: true,
    conditions: [{ kind: "event_match", key: "type", pattern: "m.reaction" }],
    actions: ["dont_notify"],
  },
];

const DEFAULT_CONTENT_RULES: PushRule[] = [
  {
    rule_id: ".m.rule.contains_user_name",
    default: true,
    enabled: true,
    pattern: "", // Will be replaced with localpart
    actions: [
      "notify",
      { set_tweak: "sound", value: "default" },
      { set_tweak: "highlight", value: true },
    ],
  },
];

const DEFAULT_UNDERRIDE_RULES: PushRule[] = [
  {
    rule_id: ".m.rule.call",
    default: true,
    enabled: true,
    conditions: [{ kind: "event_match", key: "type", pattern: "m.call.invite" }],
    actions: ["notify", { set_tweak: "sound", value: "ring" }],
  },
  {
    rule_id: ".m.rule.encrypted_room_one_to_one",
    default: true,
    enabled: true,
    conditions: [
      { kind: "room_member_count", is: "2" },
      { kind: "event_match", key: "type", pattern: "m.room.encrypted" },
    ],
    actions: ["notify", { set_tweak: "sound", value: "default" }],
  },
  {
    rule_id: ".m.rule.room_one_to_one",
    default: true,
    enabled: true,
    conditions: [
      { kind: "room_member_count", is: "2" },
      { kind: "event_match", key: "type", pattern: "m.room.message" },
    ],
    actions: ["notify", { set_tweak: "sound", value: "default" }],
  },
  {
    rule_id: ".org.matrix.msc3930.rule.poll_start_one_to_one",
    default: true,
    enabled: true,
    conditions: [
      { kind: "room_member_count", is: "2" },
      { kind: "event_match", key: "type", pattern: "org.matrix.msc3381.poll.start" },
    ],
    actions: ["notify", { set_tweak: "sound", value: "default" }],
  },
  {
    rule_id: ".org.matrix.msc3930.rule.poll_end_one_to_one",
    default: true,
    enabled: true,
    conditions: [
      { kind: "room_member_count", is: "2" },
      { kind: "event_match", key: "type", pattern: "org.matrix.msc3381.poll.end" },
    ],
    actions: ["notify", { set_tweak: "sound", value: "default" }],
  },
  {
    rule_id: ".org.matrix.msc3930.rule.poll_start",
    default: true,
    enabled: true,
    conditions: [{ kind: "event_match", key: "type", pattern: "org.matrix.msc3381.poll.start" }],
    actions: ["notify"],
  },
  {
    rule_id: ".org.matrix.msc3930.rule.poll_end",
    default: true,
    enabled: true,
    conditions: [{ kind: "event_match", key: "type", pattern: "org.matrix.msc3381.poll.end" }],
    actions: ["notify"],
  },
  {
    rule_id: ".m.rule.message",
    default: true,
    enabled: true,
    conditions: [{ kind: "event_match", key: "type", pattern: "m.room.message" }],
    actions: ["notify"],
  },
  {
    rule_id: ".m.rule.encrypted",
    default: true,
    enabled: true,
    conditions: [{ kind: "event_match", key: "type", pattern: "m.room.encrypted" }],
    actions: ["notify"],
  },
];

const DEFAULT_PUSH_RULE_IDS = new Set(
  [...DEFAULT_OVERRIDE_RULES, ...DEFAULT_CONTENT_RULES, ...DEFAULT_UNDERRIDE_RULES].map(
    (rule) => rule.rule_id,
  ),
);
const PUSH_RULES_ACCOUNT_DATA_TYPE = "m.push_rules";

// ============================================
// Helper Functions
// ============================================

function getDefaultRulesForUser(userId: string): {
  override: PushRule[];
  content: PushRule[];
  room: PushRule[];
  sender: PushRule[];
  underride: PushRule[];
} {
  const localpart = getMxidLocalpart(userId);

  // Clone and customize default rules
  const overrideRules = DEFAULT_OVERRIDE_RULES.map((rule) => {
    const r: PushRule = {
      ...rule,
      ...(rule.conditions ? { conditions: [...rule.conditions] } : {}),
    };
    if (r.rule_id === ".m.rule.invite_for_me" && r.conditions) {
      r.conditions = r.conditions.map(
        (c): PushCondition =>
          (c.key === "state_key" ? { ...c, pattern: userId } : { ...c }) as PushCondition,
      );
    }
    if (r.rule_id === ".m.rule.is_user_mention" && r.conditions) {
      r.conditions = r.conditions.map(
        (c): PushCondition => (c.key?.includes("user_ids") ? { ...c, value: userId } : { ...c }),
      );
    }
    return r;
  });

  const contentRules = DEFAULT_CONTENT_RULES.map((rule) => ({
    ...rule,
    ...(rule.rule_id === ".m.rule.contains_user_name" && rule.pattern !== undefined
      ? { pattern: localpart }
      : rule.pattern !== undefined
        ? { pattern: rule.pattern }
        : {}),
  })) satisfies PushRule[];

  return {
    override: overrideRules,
    content: contentRules,
    room: [],
    sender: [],
    underride: [...DEFAULT_UNDERRIDE_RULES],
  };
}

export async function getUserPushRules(
  db: D1Database,
  userId: string,
): Promise<{
  global: {
    override: PushRule[];
    content: PushRule[];
    room: PushRule[];
    sender: PushRule[];
    underride: PushRule[];
  };
}> {
  // Get custom rules from database (using existing schema: conditions, actions columns)
  const customRules = await db
    .prepare(`
    SELECT kind, rule_id, conditions, actions, enabled FROM push_rules
    WHERE user_id = ?
    ORDER BY priority ASC
  `)
    .bind(userId)
    .all<{
      kind: string;
      rule_id: string;
      conditions: string | null;
      actions: string;
      enabled: number;
    }>();

  // Start with defaults
  const rules = getDefaultRulesForUser(userId);

  // Apply custom rules (override defaults or add new)
  for (const row of customRules.results) {
    const conditions = parsePushConditionsJson(row.conditions);
    const actions = parsePushActionsJson(row.actions) ?? [];

    const ruleData: PushRule = {
      rule_id: row.rule_id,
      default: DEFAULT_PUSH_RULE_IDS.has(row.rule_id),
      enabled: row.enabled === 1,
      actions,
      ...(conditions ? { conditions } : {}),
    };

    const kindRules = rules[row.kind as keyof typeof rules];
    if (kindRules) {
      const existingIndex = kindRules.findIndex((r) => r.rule_id === row.rule_id);
      if (existingIndex >= 0) {
        // Override existing rule
        kindRules[existingIndex] = { ...kindRules[existingIndex], ...ruleData };
      } else {
        // Add new rule
        kindRules.unshift(ruleData);
      }
    }
  }

  return { global: rules };
}

async function recordPushRulesAccountDataChange(db: D1Database, userId: string): Promise<void> {
  const pos = await db
    .prepare(`
      SELECT MAX(pos) as next_pos FROM (
        SELECT COALESCE(MAX(stream_ordering), 0) as pos FROM events
        UNION ALL
        SELECT COALESCE(MAX(stream_position), 0) as pos FROM account_data_changes
      )
    `)
    .first<{ next_pos: number | null }>();
  const streamPosition = (pos?.next_pos ?? 0) + 1;

  await db
    .prepare(`
      INSERT INTO account_data_changes (user_id, room_id, event_type, stream_position)
      VALUES (?, '', ?, ?)
    `)
    .bind(userId, PUSH_RULES_ACCOUNT_DATA_TYPE, streamPosition)
    .run();
}

async function syncPushRulesAccountData(
  env: Pick<AppEnv["Bindings"], "SYNC">,
  db: D1Database,
  userId: string,
): Promise<void> {
  const pushRules = await getUserPushRules(db, userId);
  await db
    .prepare(`
      INSERT INTO account_data (user_id, room_id, event_type, content, deleted)
      VALUES (?, '', ?, ?, 0)
      ON CONFLICT (user_id, room_id, event_type) DO UPDATE SET
        content = excluded.content,
        deleted = 0
    `)
    .bind(userId, PUSH_RULES_ACCOUNT_DATA_TYPE, JSON.stringify(pushRules))
    .run();
  await recordPushRulesAccountDataChange(db, userId);
  await notifySyncUser(env, userId, { type: PUSH_RULES_ACCOUNT_DATA_TYPE });
}

// ============================================
// Pusher Endpoints
// ============================================

// GET /_matrix/client/v3/pushers - Get all pushers for user
app.get("/_matrix/client/v3/pushers", requireAuth(), async (c) => {
  const userId = c.get("userId");
  const db = c.env.DB;

  const pushers = await db
    .prepare(`
    SELECT pushkey, kind, app_id, app_display_name, device_display_name,
           profile_tag, lang, data
    FROM pushers
    WHERE user_id = ? AND enabled = 1
  `)
    .bind(userId)
    .all<{
      pushkey: string;
      kind: string;
      app_id: string;
      app_display_name: string;
      device_display_name: string;
      profile_tag: string | null;
      lang: string;
      data: string;
    }>();

  const pusherList = pushers.results.map((p) => ({
    pushkey: p.pushkey,
    kind: p.kind,
    app_id: p.app_id,
    app_display_name: p.app_display_name,
    device_display_name: p.device_display_name,
    profile_tag: p.profile_tag ?? undefined,
    lang: p.lang,
    data: parsePusherDataJson(p.data) ?? {},
  }));

  return c.json({ pushers: pusherList });
});

// POST /_matrix/client/v3/pushers/set - Create or delete a pusher
app.post("/_matrix/client/v3/pushers/set", requireAuth(), async (c) => {
  const userId = c.get("userId");
  const db = c.env.DB;
  const logger = createPushLogger("pushers_set", { user_id: userId });

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  const parsed = parsePusherRequestBody(body);
  if (!parsed) {
    return Errors.badJson().toResponse();
  }

  await runClientEffect(
    logger.info("push.command.start", {
      command: "pushers_set",
      has_kind: parsed.kind !== undefined && parsed.kind !== null,
      pushkey: parsed.pushkey,
    }),
  );

  const {
    pushkey,
    kind,
    app_id,
    app_display_name,
    device_display_name,
    profile_tag,
    lang,
    data,
    append,
  } = parsed;
  const currentAccessToken = extractAccessToken(c.req.raw);
  const currentTokenRecord = currentAccessToken
    ? await getAccessTokenRecordByHash(db, await hashToken(currentAccessToken))
    : null;
  const accessTokenId = currentTokenRecord?.tokenId ?? null;

  // Validate required fields
  if (!pushkey) {
    return Errors.missingParam("pushkey").toResponse();
  }

  // If kind is null, delete the pusher
  if (kind === null || kind === undefined) {
    await db
      .prepare(`
      DELETE FROM pushers WHERE user_id = ? AND pushkey = ? AND app_id = ?
    `)
      .bind(userId, pushkey, app_id ?? "")
      .run();

    await runClientEffect(
      logger.info("push.command.success", {
        command: "pushers_set",
        action: "delete",
        pushkey,
      }),
    );
    return c.json({});
  }

  // Validate other required fields for creating/updating
  if (!app_id || !app_display_name || !device_display_name || !lang || !data) {
    return Errors.missingParam(
      "app_id, app_display_name, device_display_name, lang, data",
    ).toResponse();
  }

  // If not appending, remove existing pushers with same pushkey
  if (!append) {
    await db
      .prepare(`
      DELETE FROM pushers WHERE user_id = ? AND pushkey = ?
    `)
      .bind(userId, pushkey)
      .run();
  }

  // Insert new pusher
  await db
    .prepare(`
    INSERT INTO pushers (
      user_id, access_token_id, pushkey, kind, app_id, app_display_name, device_display_name,
      profile_tag, lang, data
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (user_id, pushkey, app_id) DO UPDATE SET
      access_token_id = excluded.access_token_id,
      kind = excluded.kind,
      app_display_name = excluded.app_display_name,
      device_display_name = excluded.device_display_name,
      profile_tag = excluded.profile_tag,
      lang = excluded.lang,
      data = excluded.data,
      updated_at = strftime('%s', 'now') * 1000
  `)
    .bind(
      userId,
      accessTokenId,
      pushkey,
      kind,
      app_id,
      app_display_name,
      device_display_name,
      profile_tag ?? null,
      lang,
      JSON.stringify(data),
    )
    .run();
  await syncPushRulesAccountData(c.env, db, userId);

  await runClientEffect(
    logger.info("push.command.success", {
      command: "pushers_set",
      action: "upsert",
      pushkey,
      kind,
      append: append ?? false,
    }),
  );
  return c.json({});
});

// ============================================
// Push Rules Endpoints
// ============================================

// GET /_matrix/client/v3/pushrules - Get all push rules
// Handle both with and without trailing slash
app.get("/_matrix/client/v3/pushrules", requireAuth(), async (c) => {
  const userId = c.get("userId");
  const db = c.env.DB;

  const rules = await getUserPushRules(db, userId);

  return c.json(rules);
});

app.get("/_matrix/client/v3/pushrules/", requireAuth(), async (c) => {
  const userId = c.get("userId");
  const db = c.env.DB;

  const rules = await getUserPushRules(db, userId);

  return c.json(rules);
});

// GET /_matrix/client/v3/pushrules/global - Get global push rules
app.get("/_matrix/client/v3/pushrules/global", requireAuth(), async (c) => {
  const userId = c.get("userId");
  const db = c.env.DB;

  const rules = await getUserPushRules(db, userId);

  return c.json(rules.global);
});

// GET /_matrix/client/v3/pushrules/:scope/:kind/:ruleId - Get specific rule
app.get("/_matrix/client/v3/pushrules/:scope/:kind/:ruleId", requireAuth(), async (c) => {
  const userId = c.get("userId");
  const scope = c.req.param("scope");
  const kind = c.req.param("kind");
  const ruleId = decodeURIComponent(c.req.param("ruleId"));
  const db = c.env.DB;

  if (scope !== "global") {
    return c.json(
      {
        errcode: "M_INVALID_PARAM",
        error: "Only global scope is supported",
      },
      400,
    );
  }

  const rules = await getUserPushRules(db, userId);
  const kindRules = rules.global[kind as keyof typeof rules.global];

  if (!kindRules) {
    return c.json(
      {
        errcode: "M_INVALID_PARAM",
        error: `Unknown rule kind: ${kind}`,
      },
      400,
    );
  }

  const rule = kindRules.find((r) => r.rule_id === ruleId);
  if (!rule) {
    return c.json(
      {
        errcode: "M_NOT_FOUND",
        error: "Push rule not found",
      },
      404,
    );
  }

  return c.json(rule);
});

// PUT /_matrix/client/v3/pushrules/:scope/:kind/:ruleId - Create/update rule
app.put("/_matrix/client/v3/pushrules/:scope/:kind/:ruleId", requireAuth(), async (c) => {
  const userId = c.get("userId");
  const scope = c.req.param("scope");
  const kind = c.req.param("kind");
  const ruleId = decodeURIComponent(c.req.param("ruleId"));
  const db = c.env.DB;
  const logger = createPushLogger("pushrules_upsert", { user_id: userId });

  if (scope !== "global") {
    return c.json(
      {
        errcode: "M_INVALID_PARAM",
        error: "Only global scope is supported",
      },
      400,
    );
  }

  // Can't modify default rules (they start with .)
  if (ruleId.startsWith(".m.rule.")) {
    return c.json(
      {
        errcode: "M_CANNOT_OVERWRITE_DEFAULT",
        error: "Cannot overwrite default rules",
      },
      400,
    );
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  const parsed = parsePushRuleUpsertRequest(body);
  if (!parsed) {
    return Errors.badJson().toResponse();
  }

  const { actions, conditions, pattern } = parsed;

  // Content rules require pattern
  if (kind === "content" && !pattern) {
    return Errors.missingParam("pattern").toResponse();
  }

  // Build rule data
  const ruleData: PushRule = {
    rule_id: ruleId,
    default: false,
    enabled: true,
    actions,
  };

  if (conditions) {
    ruleData.conditions = conditions;
  }

  if (pattern) {
    ruleData.pattern = pattern;
  }

  // Get priority from query params
  const before = c.req.query("before");
  const after = c.req.query("after");
  let priority = 0;

  if (before || after) {
    priority = Date.now();
  }

  await db
    .prepare(`
    INSERT INTO push_rules (user_id, kind, rule_id, conditions, actions, enabled, priority)
    VALUES (?, ?, ?, ?, ?, 1, ?)
    ON CONFLICT (user_id, kind, rule_id) DO UPDATE SET
      conditions = excluded.conditions,
      actions = excluded.actions,
      priority = excluded.priority
  `)
    .bind(
      userId,
      kind,
      ruleId,
      conditions ? JSON.stringify(conditions) : null,
      JSON.stringify(actions),
      priority,
    )
    .run();
  await syncPushRulesAccountData(c.env, db, userId);

  await runClientEffect(
    logger.info("push.command.success", {
      command: "pushrules_upsert",
      kind,
      rule_id: ruleId,
      has_conditions: Boolean(conditions),
      action_count: actions.length,
    }),
  );
  return c.json({});
});

// DELETE /_matrix/client/v3/pushrules/:scope/:kind/:ruleId - Delete rule
app.delete("/_matrix/client/v3/pushrules/:scope/:kind/:ruleId", requireAuth(), async (c) => {
  const userId = c.get("userId");
  const scope = c.req.param("scope");
  const kind = c.req.param("kind");
  const ruleId = decodeURIComponent(c.req.param("ruleId"));
  const db = c.env.DB;

  if (scope !== "global") {
    return c.json(
      {
        errcode: "M_INVALID_PARAM",
        error: "Only global scope is supported",
      },
      400,
    );
  }

  // Can't delete default rules
  if (ruleId.startsWith(".m.rule.")) {
    return c.json(
      {
        errcode: "M_CANNOT_DELETE_DEFAULT",
        error: "Cannot delete default rules",
      },
      400,
    );
  }

  const result = await db
    .prepare(`
    DELETE FROM push_rules WHERE user_id = ? AND kind = ? AND rule_id = ?
  `)
    .bind(userId, kind, ruleId)
    .run();

  if (result.meta.changes === 0) {
    return c.json(
      {
        errcode: "M_NOT_FOUND",
        error: "Push rule not found",
      },
      404,
    );
  }

  await syncPushRulesAccountData(c.env, db, userId);

  return c.json({});
});

// PUT /_matrix/client/v3/pushrules/:scope/:kind/:ruleId/enabled - Enable/disable rule
app.put("/_matrix/client/v3/pushrules/:scope/:kind/:ruleId/enabled", requireAuth(), async (c) => {
  const userId = c.get("userId");
  // Note: scope is always 'global' in current implementation
  void c.req.param("scope");
  const kind = c.req.param("kind");
  const ruleId = decodeURIComponent(c.req.param("ruleId"));
  const db = c.env.DB;
  const logger = createPushLogger("pushrules_enabled", { user_id: userId });

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  const parsed = parsePushRuleEnabledRequest(body);
  if (!parsed) {
    return Errors.badJson().toResponse();
  }

  // For default rules, we need to create an override entry
  if (ruleId.startsWith(".m.rule.")) {
    // Get the default rule
    const rules = getDefaultRulesForUser(userId);
    const kindRules = rules[kind as keyof typeof rules];
    const defaultRule = kindRules?.find((r) => r.rule_id === ruleId);

    if (!defaultRule) {
      return c.json(
        {
          errcode: "M_NOT_FOUND",
          error: "Push rule not found",
        },
        404,
      );
    }

    // Store override with enabled status
    await db
      .prepare(`
      INSERT INTO push_rules (user_id, kind, rule_id, conditions, actions, enabled, priority)
      VALUES (?, ?, ?, ?, ?, ?, 0)
      ON CONFLICT (user_id, kind, rule_id) DO UPDATE SET
        enabled = excluded.enabled
    `)
      .bind(
        userId,
        kind,
        ruleId,
        defaultRule.conditions ? JSON.stringify(defaultRule.conditions) : null,
        JSON.stringify(defaultRule.actions),
        parsed.enabled ? 1 : 0,
      )
      .run();
  } else {
    // Update custom rule
    await db
      .prepare(`
      UPDATE push_rules SET enabled = ? WHERE user_id = ? AND kind = ? AND rule_id = ?
    `)
      .bind(parsed.enabled ? 1 : 0, userId, kind, ruleId)
      .run();
  }

  await syncPushRulesAccountData(c.env, db, userId);

  await runClientEffect(
    logger.info("push.command.success", {
      command: "pushrules_enabled",
      kind,
      rule_id: ruleId,
      enabled: parsed.enabled,
    }),
  );
  return c.json({});
});

// PUT /_matrix/client/v3/pushrules/:scope/:kind/:ruleId/actions - Set rule actions
app.put("/_matrix/client/v3/pushrules/:scope/:kind/:ruleId/actions", requireAuth(), async (c) => {
  const userId = c.get("userId");
  // Note: scope is always 'global' in current implementation
  void c.req.param("scope");
  const kind = c.req.param("kind");
  const ruleId = decodeURIComponent(c.req.param("ruleId"));
  const db = c.env.DB;
  const logger = createPushLogger("pushrules_actions", { user_id: userId });

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  const parsed = parsePushRuleActionsRequest(body);
  if (!parsed) {
    return Errors.badJson().toResponse();
  }

  // Get current rule (default or custom)
  const customRule = await db
    .prepare(`
    SELECT conditions, actions FROM push_rules WHERE user_id = ? AND kind = ? AND rule_id = ?
  `)
    .bind(userId, kind, ruleId)
    .first<{ conditions: string | null; actions: string }>();

  let ruleConditions: PushCondition[] | undefined;
  const ruleActions: PushAction[] = parsed.actions;

  if (customRule) {
    ruleConditions = parsePushConditionsJson(customRule.conditions);
  } else if (ruleId.startsWith(".m.rule.")) {
    // Get default rule
    const rules = getDefaultRulesForUser(userId);
    const kindRules = rules[kind as keyof typeof rules];
    const defaultRule = kindRules?.find((r) => r.rule_id === ruleId);

    if (!defaultRule) {
      return c.json(
        {
          errcode: "M_NOT_FOUND",
          error: "Push rule not found",
        },
        404,
      );
    }

    ruleConditions = defaultRule.conditions;
  } else {
    return c.json(
      {
        errcode: "M_NOT_FOUND",
        error: "Push rule not found",
      },
      404,
    );
  }

  await db
    .prepare(`
    INSERT INTO push_rules (user_id, kind, rule_id, conditions, actions, enabled, priority)
    VALUES (?, ?, ?, ?, ?, 1, 0)
    ON CONFLICT (user_id, kind, rule_id) DO UPDATE SET
      actions = excluded.actions
  `)
    .bind(
      userId,
      kind,
      ruleId,
      ruleConditions ? JSON.stringify(ruleConditions) : null,
      JSON.stringify(ruleActions),
    )
    .run();
  await syncPushRulesAccountData(c.env, db, userId);

  await runClientEffect(
    logger.info("push.command.success", {
      command: "pushrules_actions",
      kind,
      rule_id: ruleId,
      action_count: ruleActions.length,
    }),
  );
  return c.json({});
});

// ============================================
// Notifications Endpoint
// ============================================

// GET /_matrix/client/v3/notifications - Get notification history
app.get("/_matrix/client/v3/notifications", requireAuth(), async (c) => {
  const userId = c.get("userId");
  const from = c.req.query("from");
  const limit = parseInt(c.req.query("limit") ?? "20", 10);
  const only = c.req.query("only"); // 'highlight' to only show highlights
  const db = c.env.DB;

  let sincePosition = 0;
  if (from) {
    sincePosition = parseInt(from, 10) || 0;
  }

  // Get notifications from queue
  let query = `
    SELECT nq.id, nq.room_id, nq.event_id, nq.notification_type, nq.actions, nq.read, nq.created_at,
           e.event_type, e.sender, e.content
    FROM notification_queue nq
    LEFT JOIN events e ON nq.event_id = e.event_id
    WHERE nq.user_id = ?
  `;

  const params: Array<string | number> = [userId];

  if (sincePosition > 0) {
    query += ` AND nq.id > ?`;
    params.push(sincePosition);
  }

  if (only === "highlight") {
    query += ` AND nq.notification_type = 'highlight'`;
  }

  query += ` ORDER BY nq.created_at DESC LIMIT ?`;
  params.push(Math.min(limit, 100));

  const notifications = await db
    .prepare(query)
    .bind(...params)
    .all<{
      id: number;
      room_id: string;
      event_id: string;
      notification_type: string;
      actions: string;
      read: number;
      created_at: number;
      event_type: string;
      sender: string;
      content: string;
    }>();

  const notificationList = notifications.results.map((n) => {
    const content = parseJsonObjectString(n.content) ?? {};
    const actions = parsePushActionsJson(n.actions) ?? [];

    return {
      room_id: n.room_id,
      event: {
        event_id: n.event_id,
        type: n.event_type,
        sender: n.sender,
        content,
        room_id: n.room_id,
        origin_server_ts: n.created_at,
      },
      read: n.read === 1,
      ts: n.created_at,
      actions,
      profile_tag: undefined,
    };
  });

  // Calculate next_token
  let nextToken: string | undefined;
  if (notifications.results.length > 0) {
    const lastNotification = notifications.results.at(-1);
    if (lastNotification) {
      nextToken = String(lastNotification.id);
    }
  }

  return c.json({
    notifications: notificationList,
    next_token: nextToken,
  });
});

// ============================================
// Internal: Queue notification for event
// ============================================

export async function queueNotification(
  db: D1Database,
  userId: string,
  roomId: string,
  eventId: string,
  notificationType: string,
  actions: PushAction[],
): Promise<void> {
  await db
    .prepare(`
    INSERT INTO notification_queue (user_id, room_id, event_id, notification_type, actions)
    VALUES (?, ?, ?, ?, ?)
  `)
    .bind(userId, roomId, eventId, notificationType, JSON.stringify(actions))
    .run();
}

// ============================================
// Internal: Evaluate push rules for event
// ============================================

export async function evaluatePushRules(
  db: D1Database,
  userId: string,
  event: Pick<PushEvent, "type" | "content" | "sender" | "room_id" | "state_key">,
  roomMemberCount: number,
  displayName?: string,
): Promise<PushEvaluationResult> {
  const rules = await getUserPushRules(db, userId);

  // Combine all rules in priority order
  const allRules = [
    ...rules.global.override,
    ...rules.global.content,
    ...rules.global.room,
    ...rules.global.sender,
    ...rules.global.underride,
  ].filter((r) => r.enabled);

  for (const rule of allRules) {
    if (matchesRule(rule, event, userId, roomMemberCount, displayName)) {
      const notify =
        !rule.actions.includes("dont_notify") && rule.actions.some((a) => a === "notify");
      const highlight = rule.actions.some(
        (a) => typeof a === "object" && a.set_tweak === "highlight" && a.value !== false,
      );

      return { notify, actions: rule.actions, highlight };
    }
  }

  return { notify: false, actions: [], highlight: false };
}

function matchesRule(
  rule: PushRule,
  event: Pick<PushEvent, "type" | "content" | "sender" | "room_id" | "state_key">,
  userId: string,
  roomMemberCount: number,
  displayName?: string,
): boolean {
  // Content rules check pattern against body
  if (rule.pattern) {
    const body = event.content["body"];
    if (typeof body !== "string" || body.length === 0) return false;

    // Convert glob pattern to regex
    const regex = new RegExp(
      rule.pattern.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&").replaceAll("\\*", ".*"),
      "i",
    );
    return regex.test(body);
  }

  // Check all conditions
  if (rule.conditions) {
    return rule.conditions.every((condition) =>
      matchesCondition(condition, event, userId, roomMemberCount, displayName),
    );
  }

  return true;
}

function matchesCondition(
  condition: PushCondition,
  event: Pick<PushEvent, "type" | "content" | "sender" | "room_id" | "state_key">,
  userId: string,
  roomMemberCount: number,
  displayName?: string,
): boolean {
  switch (condition.kind) {
    case "event_match": {
      if (!condition.key || !condition.pattern) return false;
      const value = getNestedValue(event, condition.key);
      if (value === undefined) return false;

      // Handle user_id placeholder
      const pattern = condition.pattern === "" ? userId : condition.pattern;
      const regex = new RegExp(
        pattern.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&").replaceAll("\\*", ".*"),
        "i",
      );
      const stringValue =
        typeof value === "string" || typeof value === "number" || typeof value === "boolean"
          ? String(value)
          : (JSON.stringify(value) ?? "");
      return regex.test(stringValue);
    }

    case "room_member_count": {
      if (!condition.is) return false;
      const match = condition.is.match(/^(==|<|>|<=|>=)?(\d+)$/);
      if (!match) return false;

      const op = match[1] ?? "==";
      const count = parseInt(match[2] ?? "0", 10);

      switch (op) {
        case "==":
          return roomMemberCount === count;
        case "<":
          return roomMemberCount < count;
        case ">":
          return roomMemberCount > count;
        case "<=":
          return roomMemberCount <= count;
        case ">=":
          return roomMemberCount >= count;
        default:
          return false;
      }
    }

    case "contains_display_name": {
      if (!displayName) return false;
      const body = event.content["body"];
      if (typeof body !== "string" || body.length === 0) return false;
      return body.toLowerCase().includes(displayName.toLowerCase());
    }

    case "sender_notification_permission": {
      // Simplified: assume sender has permission
      return true;
    }

    case "event_property_is": {
      if (!condition.key) return false;
      const value = getNestedValue(event, condition.key.replaceAll("\\.", "."));
      return value === condition.value;
    }

    case "event_property_contains": {
      if (!condition.key) return false;
      const value = getNestedValue(event, condition.key.replaceAll("\\.", "."));
      if (!Array.isArray(value)) return false;
      return value.includes(condition.value);
    }

    default:
      return true;
  }
}

// ============================================
// Push Notification Delivery
// ============================================

// Generate a short correlation ID for tracking push -> NSE flow
function generatePushCorrelationId(): string {
  return Math.random().toString(36).slice(2, 10);
}

// Send push notification to a user's registered pushers
export async function sendPushNotification(
  db: D1Database,
  userId: string,
  event: PushEvent,
  counts: PushNotificationCounts,
  env?: import("../shared/types").Env, // Optional env for direct APNs delivery
): Promise<void> {
  const logger = createPushLogger("send_notification", {
    user_id: userId,
    room_id: event.room_id,
    event_id: event.event_id,
  });
  // Generate correlation ID for tracking push -> NSE flow
  const correlationId = generatePushCorrelationId();
  const pushTimestamp = new Date().toISOString();

  await runClientEffect(
    logger.info("push.command.start", {
      command: "send_notification",
      correlation_id: correlationId,
      event_type: event.type,
      sender: event.sender,
      sender_display_name: event.sender_display_name,
      room_name: event.room_name,
      timestamp: pushTimestamp,
    }),
  );

  // Get user's pushers
  const pushers = await db
    .prepare(`
    SELECT pushkey, kind, app_id, data FROM pushers WHERE user_id = ?
  `)
    .bind(userId)
    .all<{ pushkey: string; kind: string; app_id: string; data: string }>();

  if (pushers.results.length === 0) {
    await runClientEffect(
      logger.info("push.command.no_pushers", {
        correlation_id: correlationId,
      }),
    );
    return; // No pushers registered
  }

  await runClientEffect(
    logger.info("push.command.pushers_loaded", {
      correlation_id: correlationId,
      pusher_count: pushers.results.length,
      pusher_app_ids: pushers.results.map((p) => p.app_id),
    }),
  );

  // Check if direct APNs is configured
  const useDirectAPNs = env?.APNS_KEY_ID && env?.APNS_TEAM_ID && env?.APNS_PRIVATE_KEY;

  for (const pusher of pushers.results) {
    if (pusher.kind !== "http") {
      continue; // Only HTTP pushers supported
    }

    let pusherData: PusherData;
    const parsedPusherData = parsePusherDataJson(pusher.data);
    if (!parsedPusherData) {
      await runClientEffect(
        logger.warn("push.command.invalid_pusher_data", {
          correlation_id: correlationId,
          app_id: pusher.app_id,
          pushkey: pusher.pushkey,
        }),
      );
      continue;
    }
    pusherData = parsedPusherData;

    // Prepare sender and room display names
    const senderDisplayName = event.sender_display_name ?? getMxidLocalpart(event.sender);
    const roomDisplayName = event.room_name ?? "Chat";

    // Check if this is an iOS pusher (has default_payload.aps)
    const isIOSPusher = pusherData.default_payload?.["aps"] !== undefined;

    // Try direct APNs delivery for iOS pushers if configured
    if (useDirectAPNs && isIOSPusher && env) {
      const success = await sendDirectAPNs(
        env,
        pusher,
        pusherData,
        event,
        senderDisplayName,
        roomDisplayName,
        counts,
      );
      if (success) {
        // Update pusher success
        await db
          .prepare(`
          UPDATE pushers SET last_success = ?, failure_count = 0
          WHERE user_id = ? AND pushkey = ? AND app_id = ?
        `)
          .bind(Date.now(), userId, pusher.pushkey, pusher.app_id)
          .run();
        continue; // Successfully sent via direct APNs, skip Sygnal
      }
      // If direct APNs failed, fall through to Sygnal
      await runClientEffect(
        logger.warn("push.command.direct_apns_fallback", {
          correlation_id: correlationId,
          app_id: pusher.app_id,
        }),
      );
    }

    // Fall back to Sygnal (or use it directly if not iOS/no direct APNs)
    if (!pusherData.url) {
      await runClientEffect(
        logger.warn("push.command.invalid_pusher_data", {
          correlation_id: correlationId,
          app_id: pusher.app_id,
          reason: "missing_url",
        }),
      );
      continue;
    }

    // Build notification payload per Matrix Push Gateway spec
    // https://spec.matrix.org/v1.12/push-gateway-api/

    // Deep clone default_payload and populate APNs alert for proper iOS notification display
    const deviceData = cloneJsonObject(pusherData.default_payload);

    // Set direct alert body instead of loc-key/loc-args (Element X doesn't have our loc-keys)
    // This is the fallback text shown if NSE can't process the notification
    const apsPayload = parseJsonObject(deviceData["aps"]);
    if (apsPayload) {
      if (event.type === "m.room.encrypted") {
        // For encrypted messages, show sender and room (can't show content)
        apsPayload["alert"] = {
          title: senderDisplayName,
          body: roomDisplayName,
        };
      } else {
        // For unencrypted messages, show sender and message preview
        const messageBody =
          typeof event.content["body"] === "string" ? event.content["body"] : "New message";
        apsPayload["alert"] = {
          title: senderDisplayName,
          subtitle: roomDisplayName,
          body: messageBody,
        };
      }
      // Keep mutable-content so NSE can still process and override with rich content
      apsPayload["mutable-content"] = 1;
      deviceData["aps"] = apsPayload;
    }

    // NSE needs these fields to fetch event content
    // Add them to default_payload so Sygnal merges them into APNs payload
    deviceData["event_id"] = event.event_id;
    deviceData["room_id"] = event.room_id;
    deviceData["sender"] = event.sender;
    deviceData["unread_count"] = counts.unread;

    // Per Matrix Push Gateway spec, devices[].data should be the pusher data minus URL
    // Sygnal looks for default_payload nested inside data, not at the root
    const pusherDataForGateway: JsonObject = {
      ...(typeof pusherData.format === "string" ? { format: pusherData.format } : {}),
      default_payload: deviceData,
    };

    const notificationPayload: JsonObject = {
      event_id: event.event_id,
      room_id: event.room_id,
      type: event.type,
      sender: event.sender,
      sender_display_name: senderDisplayName,
      room_name: roomDisplayName,
      prio: "high",
      counts: toJsonCounts(counts),
      devices: [
        {
          app_id: pusher.app_id,
          pushkey: pusher.pushkey,
          pushkey_ts: Date.now(),
          data: pusherDataForGateway,
        },
      ],
    };

    const notification: JsonObject = {
      notification: {
        ...notificationPayload,
      },
    };

    // Include content for non-event_id_only format
    if (pusherData.format !== "event_id_only") {
      notification["notification"] = {
        ...notificationPayload,
        content: event.content,
      };
    }

    try {
      await runClientEffect(
        logger.info("push.command.dispatch", {
          correlation_id: correlationId,
          gateway_url: pusherData.url,
          app_id: pusher.app_id,
        }),
      );

      const response = await fetch(pusherData.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(notification),
      });

      if (!response.ok) {
        const text = await response.text();
        await runClientEffect(
          logger.warn("push.command.gateway_error", {
            correlation_id: correlationId,
            app_id: pusher.app_id,
            status: response.status,
            response_text: text,
          }),
        );

        // Update pusher failure count
        await db
          .prepare(`
          UPDATE pushers SET last_failure = ?, failure_count = failure_count + 1
          WHERE user_id = ? AND pushkey = ? AND app_id = ?
        `)
          .bind(Date.now(), userId, pusher.pushkey, pusher.app_id)
          .run();
      } else {
        // Parse gateway response (Sygnal returns rejected device tokens)
        let gatewayResponse: JsonObject = {};
        try {
          gatewayResponse = parseJsonObject(await response.json()) ?? {};
        } catch {
          gatewayResponse = {};
        }

        await runClientEffect(
          logger.info("push.command.success", {
            command: "send_notification",
            correlation_id: correlationId,
            app_id: pusher.app_id,
            gateway_response: gatewayResponse,
            timestamp: new Date().toISOString(),
          }),
        );

        // Update pusher success
        await db
          .prepare(`
          UPDATE pushers SET last_success = ?, failure_count = 0
          WHERE user_id = ? AND pushkey = ? AND app_id = ?
        `)
          .bind(Date.now(), userId, pusher.pushkey, pusher.app_id)
          .run();
      }
    } catch (error) {
      await runClientEffect(
        logger.error("push.command.error", error, {
          command: "send_notification",
          correlation_id: correlationId,
          app_id: pusher.app_id,
        }),
      );

      // Update pusher failure count
      await db
        .prepare(`
        UPDATE pushers SET last_failure = ?, failure_count = failure_count + 1
        WHERE user_id = ? AND pushkey = ? AND app_id = ?
      `)
        .bind(Date.now(), userId, pusher.pushkey, pusher.app_id)
        .run();
    }
  }
}

// Send push notification directly to APNs via Push Durable Object
async function sendDirectAPNs(
  env: import("../shared/types").Env,
  pusher: { pushkey: string; app_id: string },
  _pusherData: PusherData,
  event: PushEvent,
  senderDisplayName: string,
  roomDisplayName: string,
  counts: PushNotificationCounts,
): Promise<boolean> {
  const logger = createPushLogger("direct_apns", {
    room_id: event.room_id,
    event_id: event.event_id,
  });
  try {
    // Get Push Durable Object
    const pushDO = env.PUSH;
    const doId = pushDO.idFromName("apns"); // Single DO instance for APNs
    const stub = pushDO.get(doId);

    // Build APNs payload with direct alert text (bypassing Sygnal's loc-key handling)
    const aps: JsonObject = {
      "mutable-content": 1, // Allow NSE to modify
      sound: "default",
    };

    if (event.type === "m.room.encrypted") {
      // For encrypted messages, show sender and room (can't show content)
      aps["alert"] = {
        title: senderDisplayName,
        body: roomDisplayName,
      };
    } else {
      // For unencrypted messages, show sender and message preview
      const messageBody =
        typeof event.content["body"] === "string" ? event.content["body"] : "New message";
      aps["alert"] = {
        title: senderDisplayName,
        subtitle: roomDisplayName,
        body: messageBody,
      };
    }

    // Set badge to unread count
    if (counts.unread > 0) {
      aps["badge"] = counts.unread;
    }

    // Build full APNs payload with Matrix event data for NSE
    const apnsPayload = {
      aps,
      // Matrix-specific fields for NSE to fetch/decrypt the event
      room_id: event.room_id,
      event_id: event.event_id,
      sender: event.sender,
      unread_count: counts.unread,
    };

    // Determine bundle ID from app_id
    // Element X iOS uses app_id like "io.element.elementx.ios" or similar
    const topic = pusher.app_id
      .replace(/\.ios$/, "")
      .replace(/\.prod$/, "")
      .replace(/\.dev$/, "");

    await runClientEffect(
      logger.info("push.command.dispatch", {
        command: "direct_apns",
        topic,
        pushkey_prefix: `${pusher.pushkey.slice(0, 16)}...`,
        alert: aps["alert"],
      }),
    );

    // Send via Push DO
    const response = await stub.fetch(
      new Request("https://push/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pushkey: pusher.pushkey,
          topic,
          payload: apnsPayload,
          priority: 10,
        }),
      }),
    );

    const result = parseApnsGatewayResult(await response.json());
    if (!result) {
      return false;
    }

    if (result.success) {
      await runClientEffect(
        logger.info("push.command.success", {
          command: "direct_apns",
          topic,
          apns_id: result.apnsId,
        }),
      );
      return true;
    }
    await runClientEffect(
      logger.warn("push.command.gateway_error", {
        command: "direct_apns",
        topic,
        error_message: result.error,
      }),
    );
    return false;
  } catch (error) {
    await runClientEffect(
      logger.error("push.command.error", error, {
        command: "direct_apns",
      }),
    );
    return false;
  }
}

// Notify all room members about a new event (called when messages are sent)
export async function notifyRoomMembersOfMessage(
  db: D1Database,
  env: import("../shared/types").Env,
  event: PushEvent,
): Promise<void> {
  const logger = createPushLogger("notify_room_members", {
    room_id: event.room_id,
    event_id: event.event_id,
  });
  // Get all joined members except the sender
  const members = await db
    .prepare(`
    SELECT user_id FROM room_memberships
    WHERE room_id = ? AND membership = 'join' AND user_id != ?
  `)
    .bind(event.room_id, event.sender)
    .all<{ user_id: string }>();

  // Get room member count for push rule evaluation
  const memberCountResult = await db
    .prepare(`
    SELECT COUNT(*) as count FROM room_memberships
    WHERE room_id = ? AND membership = 'join'
  `)
    .bind(event.room_id)
    .first<{ count: number }>();
  const roomMemberCount = memberCountResult?.count ?? 0;

  // Get sender's display name from room membership
  const senderMembership = await db
    .prepare(`
    SELECT display_name FROM room_memberships
    WHERE room_id = ? AND user_id = ?
  `)
    .bind(event.room_id, event.sender)
    .first<{ display_name: string | null }>();
  const senderDisplayName = senderMembership?.display_name ?? getMxidLocalpart(event.sender);

  // Get room name from state
  const roomNameEvent = await db
    .prepare(`
    SELECT content FROM events
    WHERE room_id = ? AND event_type = 'm.room.name' AND state_key = ''
    ORDER BY origin_server_ts DESC LIMIT 1
  `)
    .bind(event.room_id)
    .first<{ content: string }>();
  let roomName: string | undefined;
  if (roomNameEvent) {
    const content = parseJsonObjectString(roomNameEvent.content);
    roomName = typeof content?.["name"] === "string" ? content["name"] : undefined;
  }

  // For DM rooms without explicit name, use the sender's display name as room name
  if (!roomName && roomMemberCount === 2) {
    roomName = senderDisplayName;
  }

  // Process each member in parallel
  const notifications = members.results.map(async (member) => {
    try {
      // Evaluate push rules for this user
      const pushResult = await evaluatePushRules(db, member.user_id, event, roomMemberCount);

      if (!pushResult.notify) {
        return; // User's push rules say don't notify
      }

      // Get unread count for this user in this room
      const unreadResult = await db
        .prepare(`
        SELECT COUNT(*) as count FROM events e
        WHERE e.room_id = ?
          AND e.stream_ordering > COALESCE(
            (SELECT CAST(json_extract(content, '$.event_id') AS TEXT) FROM account_data
             WHERE user_id = ? AND room_id = ? AND event_type = 'm.fully_read'),
            ''
          )
          AND e.sender != ?
          AND e.event_type IN ('m.room.message', 'm.room.encrypted')
      `)
        .bind(event.room_id, member.user_id, event.room_id, member.user_id)
        .first<{ count: number }>();

      const unreadCount = unreadResult?.count ?? 1;

      // Send push notification with sender display name and room name
      await sendPushNotification(
        db,
        member.user_id,
        {
          ...event,
          sender_display_name: senderDisplayName,
          ...(roomName ? { room_name: roomName } : {}),
        },
        { unread: unreadCount },
        env,
      );

      // Queue notification for history
      await db
        .prepare(`
        INSERT INTO notification_queue (user_id, room_id, event_id, notification_type, actions)
        VALUES (?, ?, ?, ?, ?)
      `)
        .bind(
          member.user_id,
          event.room_id,
          event.event_id,
          pushResult.highlight ? "highlight" : "notify",
          JSON.stringify(pushResult.actions),
        )
        .run();
    } catch (error) {
      await runClientEffect(
        logger.error("push.command.error", error, {
          command: "notify_room_members",
          user_id: member.user_id,
        }),
      );
    }
  });

  await Promise.all(notifications);
}

export default app;
