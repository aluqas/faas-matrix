import { describe, expect, it } from "vitest";
import {
  encodeEmptyProfileResponse,
  encodeProfileFieldResponse,
  encodeProfileResponseBody,
} from "./encoder";

describe("profile encoder", () => {
  it("encodes full and field-specific profile responses", () => {
    const profile = {
      displayname: "Alice",
      avatar_url: "mxc://test/alice",
    };

    expect(encodeProfileResponseBody(profile)).toEqual(profile);
    expect(encodeProfileFieldResponse("displayname", profile)).toEqual({
      displayname: "Alice",
    });
    expect(encodeProfileFieldResponse("avatar_url", profile)).toEqual({
      avatar_url: "mxc://test/alice",
    });
  });

  it("encodes empty profile command responses", () => {
    expect(encodeEmptyProfileResponse()).toEqual({});
  });
});
