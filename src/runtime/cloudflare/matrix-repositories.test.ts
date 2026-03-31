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
          run: async () => {
            this.statements.push({ query, args });
            return { success: true };
          },
          first: async <T>() => null as T | null,
          all: async <T>() => ({ results: [] as T[] }),
        };
      },
      run: async () => {
        this.statements.push({ query, args });
        return { success: true };
      },
      first: async <T>() => null as T | null,
      all: async <T>() => ({ results: [] as T[] }),
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
    expect(db.statements[1]?.query).toContain("INSERT INTO presence");
    expect(db.statements[1]?.args[0]).toBe("@alice:hs1");
  });
});

describe("CloudflareSyncRepository", () => {
  it("returns null for malformed cached filters", async () => {
    const repositoryModule = await import("./matrix-repositories");
    const repository = new repositoryModule.CloudflareSyncRepository({
      CACHE: {
        async get() {
          return "{invalid";
        },
      },
    } as never);

    await expect(repository.loadFilter("@alice:test", "filter-id")).resolves.toBeNull();
  });
});
