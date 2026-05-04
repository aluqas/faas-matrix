import {
  type PushCondition,
  type PushEvaluationResult,
  type PushEvent,
  type PushRule,
  parsePushActionsJson,
  parsePushConditionsJson,
} from "../../../../fatrix-model/types/push-contracts";

export const PUSH_RULES_ACCOUNT_DATA_TYPE = "m.push_rules";

function getMxidLocalpart(userId: string): string {
  const [rawLocalpart = ""] = userId.split(":");
  return rawLocalpart.startsWith("@") ? rawLocalpart.slice(1) : rawLocalpart;
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
      { kind: "event_match", key: "state_key", pattern: "" },
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
      { kind: "event_property_contains", key: "content.m\\.mentions.user_ids", value: "" },
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
    pattern: "",
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

export function getDefaultRulesForUser(userId: string): {
  override: PushRule[];
  content: PushRule[];
  room: PushRule[];
  sender: PushRule[];
  underride: PushRule[];
} {
  const localpart = getMxidLocalpart(userId);

  const overrideRules = DEFAULT_OVERRIDE_RULES.map((rule) => {
    const nextRule: PushRule = {
      ...rule,
      ...(rule.conditions ? { conditions: [...rule.conditions] } : {}),
    };
    if (nextRule.rule_id === ".m.rule.invite_for_me" && nextRule.conditions) {
      nextRule.conditions = nextRule.conditions.map(
        (condition): PushCondition =>
          (condition.key === "state_key"
            ? { ...condition, pattern: userId }
            : { ...condition }) as PushCondition,
      );
    }
    if (nextRule.rule_id === ".m.rule.is_user_mention" && nextRule.conditions) {
      nextRule.conditions = nextRule.conditions.map((condition): PushCondition =>
        condition.key?.includes("user_ids") ? { ...condition, value: userId } : { ...condition },
      );
    }
    return nextRule;
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

  const rules = getDefaultRulesForUser(userId);

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
      const existingIndex = kindRules.findIndex((rule) => rule.rule_id === row.rule_id);
      if (existingIndex >= 0) {
        kindRules[existingIndex] = { ...kindRules[existingIndex], ...ruleData };
      } else {
        kindRules.unshift(ruleData);
      }
    }
  }

  return { global: rules };
}

export async function evaluatePushRules(
  db: D1Database,
  userId: string,
  event: Pick<PushEvent, "type" | "content" | "sender" | "room_id" | "state_key">,
  roomMemberCount: number,
  displayName?: string,
): Promise<PushEvaluationResult> {
  const rules = await getUserPushRules(db, userId);

  const allRules = [
    ...rules.global.override,
    ...rules.global.content,
    ...rules.global.room,
    ...rules.global.sender,
    ...rules.global.underride,
  ].filter((rule) => rule.enabled);

  for (const rule of allRules) {
    if (matchesRule(rule, event, userId, roomMemberCount, displayName)) {
      const notify =
        !rule.actions.includes("dont_notify") && rule.actions.some((action) => action === "notify");
      const highlight = rule.actions.some(
        (action) =>
          typeof action === "object" &&
          action.set_tweak === "highlight" &&
          action.value !== false,
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
  if (rule.pattern) {
    const body = event.content["body"];
    if (typeof body !== "string" || body.length === 0) return false;

    const regex = new RegExp(
      rule.pattern.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&").replaceAll("\\*", ".*"),
      "i",
    );
    return regex.test(body);
  }

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
      const count = Number.parseInt(match[2] ?? "0", 10);

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
