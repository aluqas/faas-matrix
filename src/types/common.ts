export type JsonObject = Record<string, unknown>;

export type JsonBodyParseResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: "not_json" | "bad_json" };
