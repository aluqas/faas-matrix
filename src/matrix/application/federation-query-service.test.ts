import { describe, expect, it } from "vitest";
import { FederationQueryService } from "./federation-query-service";

class FakeD1Database {
  users = new Map<string, { display_name: string | null; avatar_url: string | null }>();

  prepare(query: string) {
    let boundArgs: unknown[] = [];

    const lookupUser = () => {
      if (!query.includes("users") || !query.includes("user_id")) {
        return null;
      }

      const userId = boundArgs[0] as string;
      const user = this.users.get(userId);
      if (!user) {
        return null;
      }

      return {
        user_id: userId,
        localpart: userId.slice(1).split(":")[0],
        display_name: user.display_name,
        avatar_url: user.avatar_url,
        is_guest: 0,
        is_deactivated: 0,
        admin: 0,
        created_at: 0,
      };
    };

    return {
      bind(...args: unknown[]) {
        boundArgs = args;
        return this;
      },
      all: async () => {
        const row = lookupUser();
        return { results: row ? [row] : [] };
      },
      first: async () => {
        return lookupUser();
      },
    };
  }
}

describe("FederationQueryService", () => {
  it("returns local profiles without federation", async () => {
    const service = new FederationQueryService();
    const db = new FakeD1Database();
    db.users.set("@alice:test", {
      display_name: "Alice",
      avatar_url: "mxc://test/avatar",
    });

    await expect(
      service.getProfile({
        userId: "@alice:test",
        localServerName: "test",
        db: db as unknown as D1Database,
        cache: {} as KVNamespace,
      }),
    ).resolves.toEqual({
      displayname: "Alice",
      avatar_url: "mxc://test/avatar",
    });
  });

  it("queries remote federation profile endpoints for remote users", async () => {
    const service = new FederationQueryService();

    await expect(
      service.getProfile({
        userId: "@alice:remote.example",
        field: "displayname",
        localServerName: "test",
        db: {} as D1Database,
        cache: {} as KVNamespace,
        async fetchProfile(serverName, path) {
          expect(serverName).toBe("remote.example");
          expect(path).toContain("/_matrix/federation/v1/query/profile?");
          expect(path).toContain("user_id=%40alice%3Aremote.example");
          expect(path).toContain("field=displayname");
          return new Response(JSON.stringify({ displayname: "Remote Alice" }), { status: 200 });
        },
      }),
    ).resolves.toEqual({
      displayname: "Remote Alice",
      avatar_url: null,
    });
  });
});
