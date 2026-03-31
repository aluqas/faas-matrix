import { describe, expect, it } from "vitest";
import {
  parsePushActions,
  parsePushActionsJson,
  parsePushConditions,
  parsePushConditionsJson,
  parseJsonObject,
  parseJsonObjectString,
  parsePusherData,
  parsePusherDataJson,
  parsePusherRequestBody,
  parsePushRuleActionsRequest,
  parsePushRuleEnabledRequest,
  parsePushRuleUpsertRequest,
} from "./push-contracts";

describe("push contracts", () => {
  it("parses push actions and conditions", () => {
    expect(parsePushActions(["notify", { set_tweak: "sound", value: "default" }])).toEqual([
      "notify",
      { set_tweak: "sound", value: "default" },
    ]);
    expect(parsePushActions(["notify", { bad: true }])).toBeNull();

    expect(
      parsePushConditions([{ kind: "event_match", key: "type", pattern: "m.room.message" }]),
    ).toEqual([{ kind: "event_match", key: "type", pattern: "m.room.message" }]);
    expect(parsePushConditions([{ key: "type" }])).toBeNull();
  });

  it("parses pusher registration payloads", () => {
    expect(
      parsePusherRequestBody({
        pushkey: "key",
        kind: "http",
        app_id: "app",
        app_display_name: "App",
        device_display_name: "Phone",
        lang: "en",
        data: { url: "https://push.example", default_payload: { aps: {} } },
      }),
    ).toEqual({
      pushkey: "key",
      kind: "http",
      app_id: "app",
      app_display_name: "App",
      device_display_name: "Phone",
      lang: "en",
      data: { url: "https://push.example", default_payload: { aps: {} } },
    });

    expect(parsePusherRequestBody({ pushkey: "key", data: "bad" })).toBeNull();
    expect(parsePusherData({ url: "https://push.example" })).toEqual({
      url: "https://push.example",
    });
    expect(parsePusherData({ url: 1 })).toBeNull();
  });

  it("parses rule update payloads", () => {
    expect(
      parsePushRuleUpsertRequest({
        actions: ["notify"],
        conditions: [{ kind: "event_match", key: "type", pattern: "m.room.message" }],
      }),
    ).toEqual({
      actions: ["notify"],
      conditions: [{ kind: "event_match", key: "type", pattern: "m.room.message" }],
    });
    expect(parsePushRuleUpsertRequest({ actions: "bad" })).toBeNull();

    expect(parsePushRuleEnabledRequest({ enabled: true })).toEqual({ enabled: true });
    expect(parsePushRuleEnabledRequest({ enabled: "true" })).toBeNull();

    expect(parsePushRuleActionsRequest({ actions: ["notify"] })).toEqual({
      actions: ["notify"],
    });
    expect(parsePushRuleActionsRequest({ actions: {} })).toBeNull();
  });

  it("parses stored json payloads", () => {
    expect(parsePushActionsJson('["notify"]')).toEqual(["notify"]);
    expect(parsePushActionsJson("bad")).toBeUndefined();

    expect(
      parsePushConditionsJson('[{"kind":"event_match","key":"type","pattern":"m.room.message"}]'),
    ).toEqual([{ kind: "event_match", key: "type", pattern: "m.room.message" }]);
    expect(parsePushConditionsJson("bad")).toBeUndefined();

    expect(parsePusherDataJson('{"url":"https://push.example"}')).toEqual({
      url: "https://push.example",
    });
    expect(parsePusherDataJson("bad")).toBeUndefined();

    expect(parseJsonObject({ body: "hello" })).toEqual({ body: "hello" });
    expect(parseJsonObjectString('{"body":"hello"}')).toEqual({ body: "hello" });
    expect(parseJsonObjectString("bad")).toBeUndefined();
  });
});
