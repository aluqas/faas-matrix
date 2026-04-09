import { describe, expect, it } from "vitest";
import {
  claimOneTimeKeyFromStoreChain,
  claimStoredOneTimeKeyWithMirrorMark,
  toClaimedOneTimeKeyEntry,
} from "./e2ee-claim-store";

function createDbMock(options: {
  allResults?: unknown[];
  onRun?: () => void;
}) {
  return {
    prepare: () => ({
      bind: () => ({
        all: async () => ({ results: options.allResults ?? [] }),
        run: async () => {
          options.onRun?.();
          return { success: true };
        },
      }),
    }),
    batch: async () => [],
  } as unknown as D1Database;
}

function createKvEnv(value: unknown) {
  const store = new Map<string, string>();
  if (value !== undefined) {
    store.set("otk:@alice:test:DEVICE", JSON.stringify(value));
  }

  return {
    DB: createDbMock({}),
    ONE_TIME_KEYS: {
      get: async (key: string, type?: "json") => {
        const raw = store.get(key) ?? null;
        if (raw === null) {
          return null;
        }
        return type === "json" ? JSON.parse(raw) : raw;
      },
      put: async (key: string, stored: string) => {
        store.set(key, stored);
      },
      delete: async (key: string) => {
        store.delete(key);
      },
    } as unknown as KVNamespace,
  };
}

describe("e2ee claim store", () => {
  it("claims stored keys and mirrors the claim marker into D1", async () => {
    let marked = false;
    const env = createKvEnv({
      signed_curve25519: [
        {
          keyId: "signed_curve25519:AAA",
          keyData: { key: "a" },
          claimed: false,
        },
      ],
    });
    env.DB = createDbMock({
      onRun: () => {
        marked = true;
      },
    });

    await expect(
      claimStoredOneTimeKeyWithMirrorMark(
        env,
        "@alice:test",
        "DEVICE",
        "signed_curve25519",
        123,
      ),
    ).resolves.toEqual({
      keyId: "signed_curve25519:AAA",
      keyData: { key: "a" },
    });
    expect(marked).toBe(true);
  });

  it("treats invalid stored KV payloads as errors", async () => {
    const env = createKvEnv({
      signed_curve25519: { invalid: true },
    });

    await expect(
      claimOneTimeKeyFromStoreChain(env, "@alice:test", "DEVICE", "signed_curve25519", 123),
    ).rejects.toThrow("KV one-time-keys get returned invalid payload");
  });

  it("rolls back the KV claim marker when mirroring into D1 fails", async () => {
    const env = createKvEnv({
      signed_curve25519: [
        {
          keyId: "signed_curve25519:AAA",
          keyData: { key: "a" },
          claimed: false,
        },
      ],
    });
    env.DB = createDbMock({
      onRun: () => {
        throw new Error("db mark failed");
      },
    });

    await expect(
      claimStoredOneTimeKeyWithMirrorMark(
        env,
        "@alice:test",
        "DEVICE",
        "signed_curve25519",
        123,
      ),
    ).rejects.toThrow("db mark failed");

    await expect(
      env.ONE_TIME_KEYS.get("otk:@alice:test:DEVICE", "json"),
    ).resolves.toEqual({
      signed_curve25519: [
        {
          keyId: "signed_curve25519:AAA",
          keyData: { key: "a" },
          claimed: false,
        },
      ],
    });
  });

  it("marks fallback claims in encoded entries", () => {
    expect(
      toClaimedOneTimeKeyEntry({
        keyId: "signed_curve25519:AAA",
        keyData: { key: "a" },
        isFallback: true,
      }),
    ).toEqual({
      "signed_curve25519:AAA": {
        key: "a",
        fallback: true,
      },
    });
  });
});
