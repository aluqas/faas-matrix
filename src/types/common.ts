export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };
export type UnknownRecord = Record<string, unknown>;

export type JsonBodyParseResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: "not_json" | "bad_json" };
