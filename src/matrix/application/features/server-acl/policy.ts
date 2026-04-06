import type { PDU } from "../../../../types";
import { extractServerNameFromMatrixId } from "../../../../utils/matrix-ids";
import type {
  FederationRoomScopedEdu,
  ServerAclDecision,
  ServerAclEventContent,
  ServerAclPolicy,
  ServerAclRuleSet,
} from "./contracts";

function normalizeServerName(serverName: string): string {
  return serverName.toLowerCase();
}

function escapeRegex(pattern: string): string {
  return pattern.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function patternToRegExp(pattern: string): RegExp {
  return new RegExp(`^${escapeRegex(pattern.toLowerCase()).replaceAll("\\*", ".*")}$`, "i");
}

function isIpLiteral(serverName: string): boolean {
  const normalized = normalizeServerName(serverName);
  const bracketedIpv6 = normalized.match(/^\[[^\]]+\](?::\d+)?$/);
  if (bracketedIpv6) {
    return true;
  }

  const hostOnly =
    normalized.includes(":") && normalized.indexOf(":") === normalized.lastIndexOf(":")
      ? normalized.slice(0, normalized.lastIndexOf(":"))
      : normalized;

  return /^(\d{1,3}\.){3}\d{1,3}$/.test(hostOnly) || /^[0-9a-f:]+$/i.test(hostOnly);
}

export function compileServerAclRuleSet(roomState: PDU[]): ServerAclRuleSet | null {
  const aclEvent = roomState.find(
    (event) => event.type === "m.room.server_acl" && event.state_key === "",
  );
  if (!aclEvent || !aclEvent.content || typeof aclEvent.content !== "object") {
    return null;
  }

  const content = aclEvent.content as ServerAclEventContent;
  return {
    allow: Array.isArray(content.allow) && content.allow.length > 0 ? content.allow : ["*"],
    deny: Array.isArray(content.deny) ? content.deny : [],
    allowIpLiterals: content.allow_ip_literals !== false,
  };
}

export function isServerAllowedByAcl(rules: ServerAclRuleSet | null, origin: string): boolean {
  if (!rules) {
    return true;
  }

  const normalized = normalizeServerName(origin);
  if (!rules.allowIpLiterals && isIpLiteral(normalized)) {
    return false;
  }

  const allowed = rules.allow.some((pattern) => patternToRegExp(pattern).test(normalized));
  if (!allowed) {
    return false;
  }

  const denied = rules.deny.some((pattern) => patternToRegExp(pattern).test(normalized));
  return !denied;
}

export function createServerAclPolicy(roomState: PDU[]): ServerAclPolicy {
  const rules = compileServerAclRuleSet(roomState);

  function allow(
    origins: Array<string | null | undefined>,
    roomId: string,
    descriptor: string,
  ): ServerAclDecision {
    const candidates = [...new Set(origins.filter((origin): origin is string => Boolean(origin)))];
    if (candidates.every((origin) => isServerAllowedByAcl(rules, origin))) {
      return { kind: "allow" };
    }

    const deniedOrigin =
      candidates.find((origin) => !isServerAllowedByAcl(rules, origin)) ??
      candidates[0] ??
      "unknown";
    return {
      kind: "deny",
      reason: `Server ${deniedOrigin} is denied by m.room.server_acl for ${descriptor} in ${roomId}`,
    };
  }

  return {
    allowPdu(origin: string, roomId: string, event: PDU): ServerAclDecision {
      return allow([origin, extractServerNameFromMatrixId(event.sender)], roomId, "PDU");
    },
    allowRoomScopedEdu(origin: string, roomScopedEdu: FederationRoomScopedEdu): ServerAclDecision {
      return allow(
        [origin, extractServerNameFromMatrixId(roomScopedEdu.userId)],
        roomScopedEdu.roomId,
        `EDU ${roomScopedEdu.eduType}`,
      );
    },
  };
}
