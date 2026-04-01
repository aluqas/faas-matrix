import { describe, expect, it } from "vitest";
import {
  MSC4155_INVITE_PERMISSION_EVENT_TYPE,
  decideInvitePermission,
  extractInvitePermissionConfigFromAccountData,
  parseInvitePermissionConfig,
  shouldSuppressInviteInSync,
} from "./policy";

describe("invite-permissions policy", () => {
  it("allows a user explicitly even when their server is blocked", () => {
    const decision = decideInvitePermission(
      parseInvitePermissionConfig({
        allowed_users: ["@bob:hs2"],
        blocked_servers: ["hs2"],
      }),
      "@bob:hs2",
    );

    expect(decision).toMatchObject({
      action: "allow",
      matchedBy: "allowed_users",
    });
  });

  it("blocks a user explicitly even when their server is allowed", () => {
    const decision = decideInvitePermission(
      parseInvitePermissionConfig({
        blocked_users: ["@evil:hs2"],
        allowed_servers: ["hs2"],
      }),
      "@evil:hs2",
    );

    expect(decision).toMatchObject({
      action: "block",
      matchedBy: "blocked_users",
    });
  });

  it("supports wildcard server and user matching", () => {
    expect(
      decideInvitePermission(
        parseInvitePermissionConfig({
          blocked_servers: ["hs*"],
        }),
        "@bob:hs2",
      ).action,
    ).toBe("block");

    expect(
      decideInvitePermission(
        parseInvitePermissionConfig({
          blocked_users: ["@user-?*"],
        }),
        "@user-2-bob:hs2",
      ).action,
    ).toBe("block");
  });

  it("treats ignored rules as sync suppression", () => {
    const config = parseInvitePermissionConfig({
      ignored_users: ["@bob:hs2"],
    });

    expect(shouldSuppressInviteInSync(config, "@bob:hs2")).toBe(true);
  });

  it("ignores null fields when reading account data", () => {
    const config = extractInvitePermissionConfigFromAccountData([
      {
        type: MSC4155_INVITE_PERMISSION_EVENT_TYPE,
        content: {
          allowed_users: null,
          ignored_users: null,
          blocked_users: null,
          allowed_servers: null,
          ignored_servers: null,
          blocked_servers: null,
        },
      },
    ]);

    expect(config).toEqual({
      allowedUsers: [],
      ignoredUsers: [],
      blockedUsers: [],
      allowedServers: [],
      ignoredServers: [],
      blockedServers: [],
    });
  });
});
