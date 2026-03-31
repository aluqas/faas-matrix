import type { PDU } from "../../../../types";

export interface ServerAclRuleSet {
  allow: string[];
  deny: string[];
  allowIpLiterals: boolean;
}

export type ServerAclDecision =
  | {
      kind: "allow";
    }
  | {
      kind: "deny";
      reason: string;
    };

export interface FederationRoomScopedEdu {
  eduType: string;
  roomId: string;
  userId?: string;
}

export interface ServerAclEventContent {
  allow?: string[];
  deny?: string[];
  allow_ip_literals?: boolean;
}

export interface ServerAclPolicy {
  allowPdu(origin: string, roomId: string, event: PDU): ServerAclDecision;
  allowRoomScopedEdu(origin: string, roomScopedEdu: FederationRoomScopedEdu): ServerAclDecision;
}
