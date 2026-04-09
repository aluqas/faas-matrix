import { describe, expect, it } from "vitest";

import { authorizeOwnedStateEvent } from "./policy";
import { requireRoomVersionPolicy } from "../../matrix/application/room-version-policy";

describe("owned state policy", () => {
  const v10 = requireRoomVersionPolicy("10");
  const ownedState = requireRoomVersionPolicy("org.matrix.msc3757.10");

  it("forbids reserved state keys for other users in v10 rooms", () => {
    expect(() => {
      authorizeOwnedStateEvent({
        policy: v10,
        eventType: "com.example.test",
        stateKey: "@bob:hs1",
        senderUserId: "@alice:hs1",
        actorPower: 100,
        requiredEventPower: 0,
      });
    }).toThrow(/reserved/);
  });

  it("allows exact self-owned state keys in v10 rooms", () => {
    expect(() => {
      authorizeOwnedStateEvent({
        policy: v10,
        eventType: "com.example.test",
        stateKey: "@alice:hs1",
        senderUserId: "@alice:hs1",
        actorPower: 0,
        requiredEventPower: 0,
      });
    }).not.toThrow();
  });

  it("allows suffixed owned-state writes for the owner in MSC3757 rooms", () => {
    expect(() => {
      authorizeOwnedStateEvent({
        policy: ownedState,
        eventType: "com.example.test",
        stateKey: "@alice:hs1_suffix",
        senderUserId: "@alice:hs1",
        actorPower: 0,
        requiredEventPower: 0,
      });
    }).not.toThrow();
  });

  it("allows privileged users to write another user's owned state in MSC3757 rooms", () => {
    expect(() => {
      authorizeOwnedStateEvent({
        policy: ownedState,
        eventType: "com.example.test",
        stateKey: "@alice:hs1_suffix",
        senderUserId: "@creator:hs1",
        actorPower: 100,
        requiredEventPower: 0,
      });
    }).not.toThrow();
  });

  it("rejects malformed state keys in MSC3757 rooms", () => {
    expect(() => {
      authorizeOwnedStateEvent({
        policy: ownedState,
        eventType: "com.example.test",
        stateKey: "@oops",
        senderUserId: "@creator:hs1",
        actorPower: 100,
        requiredEventPower: 0,
      });
    }).toThrow(/valid Matrix user ID/);
  });

  it("rejects improperly suffixed state keys in MSC3757 rooms", () => {
    expect(() => {
      authorizeOwnedStateEvent({
        policy: ownedState,
        eventType: "com.example.test",
        stateKey: "@creator:hs1@state_key_suffix",
        senderUserId: "@creator:hs1",
        actorPower: 100,
        requiredEventPower: 0,
      });
    }).toThrow(/suffix/);
  });
});
