import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("to-device route boundary", () => {
  it("keeps api/to-device.ts focused on decode and send orchestration", () => {
    const source = readFileSync(new URL("./to-device.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/\bgetToDeviceMessages\(/);
    expect(source).not.toMatch(/\bcleanupOldToDeviceMessages\(/);
    expect(source).not.toMatch(/\bdeleteDeliveredToDeviceMessagesBefore\(/);
    expect(source).not.toMatch(/\bgetDeviceMessagesAfter\(/);
    expect(source).toMatch(/\bdecodeSendToDeviceInput\(/);
    expect(source).toMatch(/\bsendToDeviceEffect\(/);
  });
});
