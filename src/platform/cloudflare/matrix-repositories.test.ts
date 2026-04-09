import { describe, expect, it } from "vitest";
import { CloudflareFederationRepository } from "./matrix-repositories";

class RecordingD1Database {
  public readonly statements: Array<{ query: string; args: unknown[] }> = [];

  prepare(query: string) {
    let args: unknown[] = [];

    return {
      bind: (...boundArgs: unknown[]) => {
        args = boundArgs;
        return {
          run: () => {
            this.statements.push({ query, args });
            return { success: true };
          },
          first: <T>() => null as T | null,
          all: <T>() => ({ results: [] as T[] }),
        };
      },
      run: () => {
        this.statements.push({ query, args });
        return { success: true };
      },
      first: <T>() => null as T | null,
      all: <T>() => ({ results: [] as T[] }),
    };
  }
}

class QueryResultD1Database {
  prepare(query: string) {
    return {
      bind: (..._boundArgs: unknown[]) => {
        return {
          run: () => ({ success: true }),
          first: <T>() => null as T | null,
          all: <T>() => {
            if (query.includes("FROM device_key_changes")) {
              return {
                results: [{ user_id: "@alice:test" }, { user_id: "@bob:test" }] as T[],
              };
            }
            if (query.includes("FROM remote_device_list_streams")) {
              return {
                results: [{ user_id: "@carol:test" }] as T[],
              };
            }
            if (query.includes("FROM events requester_join_event")) {
              return {
                results: [{ user_id: "@frank:test" }] as T[],
              };
            }
            if (query.includes("json_extract(e.content, '$.membership') = 'join'")) {
              return {
                results: [{ user_id: "@dave:test" }] as T[],
              };
            }
            if (query.includes("json_extract(e.content, '$.membership') IN ('leave', 'ban')")) {
              return {
                results: [{ user_id: "@erin:test" }, { user_id: "@bob:test" }] as T[],
              };
            }

            return { results: [] as T[] };
          },
        };
      },
      run: () => ({ success: true }),
      first: <T>() => null as T | null,
      all: <T>() => {
        if (query.includes("FROM device_key_changes")) {
          return {
            results: [{ user_id: "@alice:test" }, { user_id: "@bob:test" }] as T[],
          };
        }
        if (query.includes("FROM remote_device_list_streams")) {
          return {
            results: [{ user_id: "@carol:test" }] as T[],
          };
        }
        if (query.includes("FROM events requester_join_event")) {
          return {
            results: [{ user_id: "@frank:test" }] as T[],
          };
        }
        if (query.includes("json_extract(e.content, '$.membership') = 'join'")) {
          return {
            results: [{ user_id: "@dave:test" }] as T[],
          };
        }
        if (query.includes("json_extract(e.content, '$.membership') IN ('leave', 'ban')")) {
          return {
            results: [{ user_id: "@erin:test" }, { user_id: "@bob:test" }] as T[],
          };
        }

        return { results: [] as T[] };
      },
    };
  }
}

describe("CloudflareFederationRepository", () => {
  it("ensures a user stub exists before storing remote presence", async () => {
    const db = new RecordingD1Database();
    const repository = new CloudflareFederationRepository({
      DB: db as unknown as D1Database,
    } as never);

    await repository.upsertPresence("@alice:hs1", "online", "Available", Date.now(), true);

    expect(db.statements).toHaveLength(2);
    expect(db.statements[0]?.query).toContain("INSERT OR IGNORE INTO users");
    expect(db.statements[0]?.args[0]).toBe("@alice:hs1");
    expect(db.statements[0]?.args[1]).toBe("@alice:hs1");
    expect(db.statements[1]?.query.toLowerCase()).toContain("insert into");
    expect(db.statements[1]?.query.toLowerCase()).toContain("presence");
    expect(db.statements[1]?.args[0]).toBe("@alice:hs1");
  });
});

describe("CloudflareSyncRepository", () => {
  it("returns null for malformed cached filters", async () => {
    const repositoryModule = await import("./matrix-repositories");
    const repository = new repositoryModule.CloudflareSyncRepository({
      CACHE: {
        get() {
          return "{invalid";
        },
      },
    } as never);

    await expect(repository.loadFilter("@alice:test", "filter-id")).resolves.toBeNull();
  });

  it("merges local, remote, membership-join, and left device-list changes", async () => {
    const repositoryModule = await import("./matrix-repositories");
    const repository = new repositoryModule.CloudflareSyncRepository({
      DB: new QueryResultD1Database() as unknown as D1Database,
    } as never);

    await expect(repository.getDeviceListChanges("@alice:test", 5, 7)).resolves.toEqual({
      changed: ["@alice:test", "@bob:test", "@carol:test", "@dave:test", "@frank:test"],
      left: ["@erin:test"],
    });
  });
});
