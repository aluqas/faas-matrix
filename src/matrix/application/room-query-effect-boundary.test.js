import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("room-query effect boundary", () => {
  it("does not execute the client runtime inside room-query-service", () => {
    const source = readFileSync(new URL("./room-query-service.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/\brunClientEffect\(/);
  });
});
