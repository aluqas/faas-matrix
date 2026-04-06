import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("account-data route boundary", () => {
  it("keeps api/account-data.ts focused on decode and use-case calls", () => {
    const source = readFileSync(new URL("./account-data.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/\bDB\.prepare\(/);
    expect(source).not.toMatch(/\bACCOUNT_DATA\.(get|put|delete)\(/);
    expect(source).not.toMatch(/\bnotifySyncUser\(/);
    expect(source).not.toMatch(/\bJSON\.parse\(/);
    expect(source).toMatch(/decodeGetGlobalAccountDataInput/);
    expect(source).toMatch(/queryGlobalAccountDataEffect/);
    expect(source).toMatch(/upsertGlobalAccountDataEffect/);
    expect(source).toMatch(/queryRoomAccountDataEffect/);
    expect(source).toMatch(/upsertRoomAccountDataEffect/);
  });
});
