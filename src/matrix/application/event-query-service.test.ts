import { describe, expect, it } from "vitest";
import { normalizeOffsetToken, selectSpaceChildren } from "./event-query-service";

describe("normalizeOffsetToken", () => {
  it("parses offset pagination tokens", () => {
    expect(normalizeOffsetToken("offset_12")).toBe(12);
    expect(normalizeOffsetToken("offset_-1")).toBe(0);
    expect(normalizeOffsetToken("bad")).toBe(0);
    expect(normalizeOffsetToken(undefined)).toBe(0);
  });
});

describe("selectSpaceChildren", () => {
  const children = [
    { roomId: "!a:test", content: { via: ["test"], suggested: true } },
    { roomId: "!b:test", content: { via: ["test"], suggested: false } },
    { roomId: "!c:test", content: { via: [], suggested: true } },
  ];

  it("filters deleted children and paginates", () => {
    const result = selectSpaceChildren(children, {
      suggestedOnly: false,
      limit: 1,
      offset: 0,
    });

    expect(result.children.map((child) => child.roomId)).toEqual(["!a:test"]);
    expect(result.hasMore).toBe(true);
  });

  it("honors suggested_only filtering", () => {
    const result = selectSpaceChildren(children, {
      suggestedOnly: true,
      limit: 10,
      offset: 0,
    });

    expect(result.children.map((child) => child.roomId)).toEqual(["!a:test"]);
    expect(result.hasMore).toBe(false);
  });
});
