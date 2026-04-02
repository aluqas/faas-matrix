import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("rooms membership route boundary", () => {
  it("keeps membership routing thin", () => {
    const source = readFileSync(new URL("./membership.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/\brunClientEffect\(/);
    expect(source).not.toMatch(/\bfanoutEventToRemoteServers\b/);
    expect(source).toMatch(/services\.rooms\.joinRoom/);
    expect(source).toMatch(/services\.rooms\.leaveRoom/);
    expect(source).toMatch(/services\.rooms\.knockRoom/);
  });
});
