import type { AccountDataEvent } from "../../../../types";
import { parseUserId } from "../../../../utils/ids";

export const STABLE_INVITE_PERMISSION_EVENT_TYPE = "m.invite_permission_config";
export const MSC4155_INVITE_PERMISSION_EVENT_TYPE = "org.matrix.msc4155.invite_permission_config";
export const IGNORED_USER_LIST_EVENT_TYPE = "m.ignored_user_list";

export type InvitePermissionAction = "allow" | "ignore" | "block";

export interface InvitePermissionConfig {
  allowedUsers: string[];
  ignoredUsers: string[];
  blockedUsers: string[];
  allowedServers: string[];
  ignoredServers: string[];
  blockedServers: string[];
  defaultAction?: "block";
}

export interface InvitePermissionDecision {
  action: InvitePermissionAction;
  matchedBy?: string;
  matchedValue?: string;
  inviterServerName?: string;
}

function withOptionalField<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  if (value === undefined) {
    return {};
  }

  return { [key]: value } as { [P in K]?: V };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readStringArray(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === "string");
}

function readIgnoredUsers(content: unknown): string[] {
  if (!isRecord(content)) {
    return [];
  }

  const ignoredUsers = content["ignored_users"];
  if (!isRecord(ignoredUsers)) {
    return [];
  }

  return Object.keys(ignoredUsers);
}

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replaceAll(/[.+^${}()|[\]\\]/g, "\\$&");
  const withWildcards = escaped.replaceAll('*', ".*").replaceAll('?', ".");
  return new RegExp(`^${withWildcards}$`);
}

function matchPattern(patterns: string[], value: string): string | null {
  for (const pattern of patterns) {
    if (wildcardToRegExp(pattern).test(value)) {
      return pattern;
    }
  }

  return null;
}

function defaultInvitePermissionConfig(): InvitePermissionConfig {
  return {
    allowedUsers: [],
    ignoredUsers: [],
    blockedUsers: [],
    allowedServers: [],
    ignoredServers: [],
    blockedServers: [],
  };
}

export function parseInvitePermissionConfig(content: unknown): InvitePermissionConfig {
  if (!isRecord(content)) {
    return defaultInvitePermissionConfig();
  }

  return {
    allowedUsers: readStringArray(content, "allowed_users"),
    ignoredUsers: readStringArray(content, "ignored_users"),
    blockedUsers: readStringArray(content, "blocked_users"),
    allowedServers: readStringArray(content, "allowed_servers"),
    ignoredServers: readStringArray(content, "ignored_servers"),
    blockedServers: readStringArray(content, "blocked_servers"),
    ...(content["default_action"] === "block" ? { defaultAction: "block" as const } : {}),
  };
}

export function extractInvitePermissionConfigFromAccountData(
  accountData: AccountDataEvent[],
): InvitePermissionConfig {
  const ignoredUsers = accountData
    .filter((event) => event.type === IGNORED_USER_LIST_EVENT_TYPE)
    .flatMap((event) => readIgnoredUsers(event.content));

  const stable = accountData.find((event) => event.type === STABLE_INVITE_PERMISSION_EVENT_TYPE);
  if (stable) {
    const parsed = parseInvitePermissionConfig(stable.content);
    return {
      ...parsed,
      ignoredUsers: Array.from(new Set([...parsed.ignoredUsers, ...ignoredUsers])),
    };
  }

  const unstable = accountData.find((event) => event.type === MSC4155_INVITE_PERMISSION_EVENT_TYPE);
  if (unstable) {
    const parsed = parseInvitePermissionConfig(unstable.content);
    return {
      ...parsed,
      ignoredUsers: Array.from(new Set([...parsed.ignoredUsers, ...ignoredUsers])),
    };
  }

  return {
    ...defaultInvitePermissionConfig(),
    ignoredUsers: Array.from(new Set(ignoredUsers)),
  };
}

export async function loadInvitePermissionConfig(
  db: D1Database,
  userId: string,
): Promise<InvitePermissionConfig> {
  const rows = await db
    .prepare(
      `
      SELECT event_type, content
      FROM account_data
      WHERE user_id = ? AND room_id = '' AND deleted = 0
        AND event_type IN (?, ?, ?)
      ORDER BY CASE event_type
        WHEN ? THEN 0
        WHEN ? THEN 1
        WHEN ? THEN 2
        ELSE 2
      END
    `,
    )
    .bind(
      userId,
      STABLE_INVITE_PERMISSION_EVENT_TYPE,
      MSC4155_INVITE_PERMISSION_EVENT_TYPE,
      IGNORED_USER_LIST_EVENT_TYPE,
      STABLE_INVITE_PERMISSION_EVENT_TYPE,
      MSC4155_INVITE_PERMISSION_EVENT_TYPE,
      IGNORED_USER_LIST_EVENT_TYPE,
    )
    .all<{ event_type: string; content: string }>();

  if (rows.results.length === 0) {
    return defaultInvitePermissionConfig();
  }

  const accountData: AccountDataEvent[] = rows.results.flatMap((row) => {
    try {
      return [
        { type: row.event_type, content: JSON.parse(row.content) as Record<string, unknown> },
      ];
    } catch {
      return [];
    }
  });

  return extractInvitePermissionConfigFromAccountData(accountData);
}

export function decideInvitePermission(
  config: InvitePermissionConfig,
  inviterUserId: string,
  inviterServerName?: string,
): InvitePermissionDecision {
  const parsed = parseUserId(inviterUserId);
  const serverName = inviterServerName ?? parsed?.serverName;

  const allowedUserPattern = matchPattern(config.allowedUsers, inviterUserId);
  if (allowedUserPattern) {
    return {
      action: "allow",
      matchedBy: "allowed_users",
      matchedValue: allowedUserPattern,
      ...withOptionalField("inviterServerName", serverName),
    };
  }

  const blockedUserPattern = matchPattern(config.blockedUsers, inviterUserId);
  if (blockedUserPattern) {
    return {
      action: "block",
      matchedBy: "blocked_users",
      matchedValue: blockedUserPattern,
      ...withOptionalField("inviterServerName", serverName),
    };
  }

  const ignoredUserPattern = matchPattern(config.ignoredUsers, inviterUserId);
  if (ignoredUserPattern) {
    return {
      action: "ignore",
      matchedBy: "ignored_users",
      matchedValue: ignoredUserPattern,
      ...withOptionalField("inviterServerName", serverName),
    };
  }

  if (serverName) {
    const blockedServerPattern = matchPattern(config.blockedServers, serverName);
    if (blockedServerPattern) {
      return {
        action: "block",
        matchedBy: "blocked_servers",
        matchedValue: blockedServerPattern,
        ...withOptionalField("inviterServerName", serverName),
      };
    }

    const ignoredServerPattern = matchPattern(config.ignoredServers, serverName);
    if (ignoredServerPattern) {
      return {
        action: "ignore",
        matchedBy: "ignored_servers",
        matchedValue: ignoredServerPattern,
        ...withOptionalField("inviterServerName", serverName),
      };
    }

    const allowedServerPattern = matchPattern(config.allowedServers, serverName);
    if (allowedServerPattern) {
      return {
        action: "allow",
        matchedBy: "allowed_servers",
        matchedValue: allowedServerPattern,
        ...withOptionalField("inviterServerName", serverName),
      };
    }
  }

  if (config.defaultAction === "block") {
    return {
      action: "block",
      matchedBy: "default_action",
      matchedValue: "block",
      ...withOptionalField("inviterServerName", serverName),
    };
  }

  return {
    action: "allow",
    ...withOptionalField("inviterServerName", serverName),
  };
}

export function shouldSuppressInviteInSync(
  config: InvitePermissionConfig,
  inviterUserId: string,
  inviterServerName?: string,
): boolean {
  return decideInvitePermission(config, inviterUserId, inviterServerName).action !== "allow";
}
