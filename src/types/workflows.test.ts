import { describe, expect, it } from "vitest";
import { toRemoteJoinTemplate, toRemoteSendJoinResponse } from "./workflows";

describe("workflow contracts", () => {
  it("normalizes a valid remote join template", () => {
    expect(
      toRemoteJoinTemplate({
        room_version: "10",
        event: {
          auth_events: ["$a", 1, "$b"],
          prev_events: ["$c"],
          depth: 4,
        },
      }),
    ).toEqual({
      room_version: "10",
      event: {
        auth_events: ["$a", "$b"],
        prev_events: ["$c"],
        depth: 4,
      },
    });
  });

  it("returns null for an invalid remote join template", () => {
    expect(toRemoteJoinTemplate({ room_version: 10, event: {} })).toBeNull();
    expect(toRemoteJoinTemplate(null)).toBeNull();
  });

  it("normalizes remote send_join responses", () => {
    expect(toRemoteSendJoinResponse([[{ event_id: "$state" }], [{ event_id: "$auth" }]])).toEqual({
      state: [{ event_id: "$state" }],
      auth_chain: [{ event_id: "$auth" }],
    });

    expect(
      toRemoteSendJoinResponse({
        state: [{ event_id: "$state" }],
        auth_chain: [{ event_id: "$auth" }],
      }),
    ).toEqual({
      state: [{ event_id: "$state" }],
      auth_chain: [{ event_id: "$auth" }],
    });
  });
});
