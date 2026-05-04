export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };
export type UnknownRecord = Record<string, unknown>;

export type JsonBodyParseResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: "not_json" | "bad_json" };

export function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return true;
  }

  if (Array.isArray(value)) {
    return value.every((entry) => isJsonValue(entry));
  }

  if (value !== null && typeof value === "object") {
    return Object.values(value).every((entry) => isJsonValue(entry));
  }

  return false;
}

export function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) && isJsonValue(value);
}
