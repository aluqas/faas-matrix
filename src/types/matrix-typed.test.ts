import { describe, expectTypeOf, it } from "vitest";
import type { JsonObject } from "./common";
import type {
  AccountDataEventOf,
  MatrixEventOf,
  PduOf,
  StateEventOf,
  ToDeviceEventOf,
} from "./matrix-typed";

describe("matrix typed generics", () => {
  it("keeps generic event content opt-in and exact", () => {
    type MemberContent = JsonObject & {
      membership: "join" | "invite";
      displayname?: string;
    };

    expectTypeOf<
      MatrixEventOf<MemberContent, "m.room.member">["type"]
    >().toEqualTypeOf<"m.room.member">();
    expectTypeOf<
      MatrixEventOf<MemberContent, "m.room.member">["content"]
    >().toEqualTypeOf<MemberContent>();
    expectTypeOf<
      StateEventOf<MemberContent, "m.room.member">["content"]
    >().toEqualTypeOf<MemberContent>();
    expectTypeOf<PduOf<MemberContent, "m.room.member">["content"]>().toEqualTypeOf<MemberContent>();
  });

  it("supports typed top-level sync payloads without changing legacy event types", () => {
    type AccountDataContent = JsonObject & { event_id?: string };
    type ToDeviceContent = JsonObject & { body: string };

    expectTypeOf<AccountDataEventOf["content"]>().toEqualTypeOf<AccountDataContent>();
    expectTypeOf<ToDeviceEventOf<ToDeviceContent>["content"]>().toEqualTypeOf<ToDeviceContent>();
  });
});
