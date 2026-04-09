import { describe, expect, it } from "vitest";
import type { PDU } from "../../shared/types";
import { createServerAclPolicy } from "./policy";

function createEvent(overrides: Partial<PDU>): PDU {
  return {
    event_id: "$event",
    room_id: "!room:hs1",
    sender: "@alice:hs1",
    type: "m.room.message",
    content: {},
    origin_server_ts: 1,
    depth: 1,
    auth_events: [],
    prev_events: [],
    ...overrides,
  };
}

describe("server-acl policy", () => {
  it("denies PDUs from blocked servers", () => {
    const policy = createServerAclPolicy([
      createEvent({
        type: "m.room.server_acl",
        state_key: "",
        content: {
          allow: ["*"],
          deny: ["evil.example"],
          allow_ip_literals: true,
        },
      }),
    ]);

    expect(policy.allowPdu("evil.example", "!room:hs1", createEvent({}))).toEqual({
      kind: "deny",
      reason: "Server evil.example is denied by m.room.server_acl for PDU in !room:hs1",
    });
    expect(policy.allowPdu("good.example", "!room:hs1", createEvent({}))).toEqual({
      kind: "allow",
    });
  });

  it("denies room-scoped EDUs from blocked servers", () => {
    const policy = createServerAclPolicy([
      createEvent({
        type: "m.room.server_acl",
        state_key: "",
        content: {
          allow: ["*"],
          deny: ["evil.example"],
        },
      }),
    ]);

    expect(
      policy.allowRoomScopedEdu("evil.example", {
        eduType: "m.typing",
        roomId: "!room:hs1",
      }),
    ).toEqual({
      kind: "deny",
      reason: "Server evil.example is denied by m.room.server_acl for EDU m.typing in !room:hs1",
    });
  });

  it("matches denied servers with explicit ports", () => {
    const policy = createServerAclPolicy([
      createEvent({
        type: "m.room.server_acl",
        state_key: "",
        content: {
          allow: ["*"],
          deny: ["host.docker.internal:8448"],
        },
      }),
    ]);

    expect(policy.allowPdu("host.docker.internal:8448", "!room:hs1", createEvent({}))).toEqual({
      kind: "deny",
      reason:
        "Server host.docker.internal:8448 is denied by m.room.server_acl for PDU in !room:hs1",
    });
  });

  it("denies PDUs when the sender domain is blocked even if the request origin differs", () => {
    const policy = createServerAclPolicy([
      createEvent({
        type: "m.room.server_acl",
        state_key: "",
        content: {
          allow: ["*"],
          deny: ["hs2"],
        },
      }),
    ]);

    expect(
      policy.allowPdu(
        "gateway.example",
        "!room:hs1",
        createEvent({
          sender: "@bob:hs2",
        }),
      ),
    ).toEqual({
      kind: "deny",
      reason: "Server hs2 is denied by m.room.server_acl for PDU in !room:hs1",
    });
  });
});
