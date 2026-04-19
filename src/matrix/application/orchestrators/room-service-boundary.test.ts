import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("room-service app-core boundary", () => {
  it("keeps room-service free of direct database helper imports", () => {
    const source = readFileSync(new URL("./room-service.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/infra\/db\/database/);
    expect(source).not.toMatch(/\bgetServersInEncryptedRoomsWithUser\(/);
    expect(source).not.toMatch(/\bgetUserDevices\(/);
    expect(source).toMatch(/room-service-repository/);
  });
});
