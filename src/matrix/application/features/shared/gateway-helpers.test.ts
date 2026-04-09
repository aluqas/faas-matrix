import { describe, expect, it } from "vitest";
import {
  fetchDurableObjectJson,
  postDurableObjectVoid,
} from "./do-gateway";
import {
  deleteKvValue,
  getKvJsonValue,
  getKvTextValue,
  putKvJsonValue,
  putKvTextValue,
} from "./kv-gateway";

function createDurableObjectEnv(responseFactory: (request: Request) => Response | Promise<Response>) {
  return {
    USER_KEYS: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: responseFactory,
      }),
    } as unknown as DurableObjectNamespace,
  };
}

function createKvNamespace() {
  const store = new Map<string, string>();
  return {
    get: async (key: string, type?: "json") => {
      const value = store.get(key) ?? null;
      if (value === null) {
        return null;
      }
      return type === "json" ? JSON.parse(value) : value;
    },
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
  } as unknown as KVNamespace;
}

describe("shared gateway helpers", () => {
  it("wraps durable object fetch success and failure", async () => {
    const okEnv = createDurableObjectEnv(async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    await expect(
      fetchDurableObjectJson(
        okEnv,
        "USER_KEYS",
        "@alice:test",
        "http://internal/device-keys/get",
        "device-keys get",
      ),
    ).resolves.toEqual({ ok: true });

    const failingEnv = createDurableObjectEnv(async () =>
      new Response("boom", { status: 503 }),
    );
    await expect(
      postDurableObjectVoid(
        failingEnv,
        "USER_KEYS",
        "@alice:test",
        "http://internal/device-keys/put",
        { ok: true },
        "device-keys put",
      ),
    ).rejects.toThrow("device-keys put failed: 503 - boom");
  });

  it("reads, writes, and deletes KV text/json values", async () => {
    const env = { CACHE: createKvNamespace() };

    await putKvTextValue(env, "CACHE", "plain", "value");
    expect(await getKvTextValue(env, "CACHE", "plain")).toBe("value");

    await putKvJsonValue(env, "CACHE", "json", { ok: true });
    expect(await getKvJsonValue(env, "CACHE", "json")).toEqual({ ok: true });

    await deleteKvValue(env, "CACHE", "plain");
    expect(await getKvTextValue(env, "CACHE", "plain")).toBeNull();
  });
});
