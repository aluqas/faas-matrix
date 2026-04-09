import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("typing route boundary", () => {
  it("keeps api/typing.ts focused on decode and use-case calls", () => {
    const source = readFileSync(new URL("./typing.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/\bDB\.prepare\(/);
    expect(source).not.toMatch(/\bisUserJoinedToRealtimeRoom\(/);
    expect(source).not.toMatch(/\bsetRoomTypingState\(/);
    expect(source).not.toMatch(/\bqueueFederationEdu\(/);
    expect(source).toMatch(/decodeSetTypingInput/);
    expect(source).toMatch(/setTypingEffect/);
  });
});
