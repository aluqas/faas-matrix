import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("receipts route boundary", () => {
  it("keeps api/receipts.ts focused on decode and use-case calls", () => {
    const source = readFileSync(new URL("./receipts.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/\bDB\.prepare\(/);
    expect(source).not.toMatch(/\bqueueFederationEdu\(/);
    expect(source).not.toMatch(/\bgetRoomState\(/);
    expect(source).not.toMatch(/\bsetRoomReceiptState\(/);
    expect(source).toMatch(/decodeSendReceiptInput/);
    expect(source).toMatch(/decodeSetReadMarkersInput/);
    expect(source).toMatch(/sendReceiptEffect/);
    expect(source).toMatch(/setReadMarkersEffect/);
  });
});
