import { beforeEach, describe, expect, it, vi } from "vitest";
import { runClientEffect } from "../../effect-runtime";
import { loadGlobalAccountDataEffect, projectGlobalAccountDataSnapshot } from "./storage";

const repositoryMocks = {
  findAccountDataRecord: vi.fn(),
  getGlobalAccountData: vi.fn(),
  getRoomAccountData: vi.fn(),
  markAccountDataDeleted: vi.fn(),
  recordAccountDataChange: vi.fn(),
  upsertAccountDataRecord: vi.fn(),
};

vi.mock("../../../repositories/account-data-repository", () => repositoryMocks);

function createEnv(options?: { doPayload?: unknown; doOk?: boolean; kvPayload?: string | null }) {
  const doPayload = options?.doPayload;
  const doOk = options?.doOk ?? true;
  const kvPayload = options?.kvPayload ?? null;

  return {
    DB: {} as D1Database,
    USER_KEYS: {
      idFromName(userId: string) {
        return userId;
      },
      get() {
        return {
          fetch: vi.fn(async () => ({
            ok: doOk,
            status: doOk ? 200 : 500,
            text: async () => "error",
            json: async () => doPayload,
          })),
        };
      },
    } as unknown as DurableObjectNamespace,
    ACCOUNT_DATA: {
      get: vi.fn(async () => kvPayload),
      put: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    } as unknown as KVNamespace,
  };
}

describe("account-data storage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repositoryMocks.findAccountDataRecord.mockResolvedValue(null);
    repositoryMocks.getGlobalAccountData.mockResolvedValue([]);
    repositoryMocks.getRoomAccountData.mockResolvedValue([]);
    repositoryMocks.markAccountDataDeleted.mockResolvedValue(undefined);
    repositoryMocks.recordAccountDataChange.mockResolvedValue(undefined);
    repositoryMocks.upsertAccountDataRecord.mockResolvedValue(undefined);
  });

  it("prefers DO-backed E2EE account data before KV and DB", async () => {
    const env = createEnv({
      doPayload: { "m.secret_storage.default_key": { key: "from-do" } },
    });

    const result = await runClientEffect(
      loadGlobalAccountDataEffect(env, "@alice:test", "m.secret_storage.default_key"),
    );

    expect(result).toEqual({ "m.secret_storage.default_key": { key: "from-do" } });
    expect(env.ACCOUNT_DATA.get).not.toHaveBeenCalled();
    expect(repositoryMocks.findAccountDataRecord).not.toHaveBeenCalled();
  });

  it("falls back to KV when DO-backed lookup fails", async () => {
    const env = createEnv({
      doOk: false,
      kvPayload: JSON.stringify({ key: "from-kv" }),
    });

    const result = await runClientEffect(
      loadGlobalAccountDataEffect(env, "@alice:test", "m.secret_storage.default_key"),
    );

    expect(result).toEqual({ key: "from-kv" });
    expect(env.ACCOUNT_DATA.get).toHaveBeenCalledWith(
      "global:@alice:test:m.secret_storage.default_key",
    );
    expect(repositoryMocks.findAccountDataRecord).not.toHaveBeenCalled();
  });

  it("falls back to database for non-E2EE account data", async () => {
    repositoryMocks.findAccountDataRecord.mockResolvedValue({
      userId: "@alice:test",
      roomId: "",
      eventType: "m.direct",
      content: { key: "from-db" },
      deleted: false,
    });

    const env = createEnv();
    const result = await runClientEffect(
      loadGlobalAccountDataEffect(env, "@alice:test", "m.direct"),
    );

    expect(result).toEqual({ key: "from-db" });
    expect(env.ACCOUNT_DATA.get).not.toHaveBeenCalled();
    expect(repositoryMocks.findAccountDataRecord).toHaveBeenCalledWith(
      env.DB,
      "@alice:test",
      "",
      "m.direct",
    );
  });

  it("merges DO-backed E2EE account data into global account-data snapshots", async () => {
    repositoryMocks.getGlobalAccountData.mockResolvedValue([
      { type: "m.direct", content: { "@alice:test": ["!room:test"] } },
    ]);

    const env = createEnv({
      doPayload: {
        "m.secret_storage.default_key": { key: "from-do" },
        "m.cross_signing.master": { usage: ["master"] },
      },
    });

    const result = await projectGlobalAccountDataSnapshot(env, "@alice:test");

    expect(result).toEqual(
      expect.arrayContaining([
        { type: "m.direct", content: { "@alice:test": ["!room:test"] } },
        { type: "m.secret_storage.default_key", content: { key: "from-do" } },
        { type: "m.cross_signing.master", content: { usage: ["master"] } },
      ]),
    );
  });
});
