import type { JsonBodyParseResult, UnknownRecord } from "../types/common";
import { Errors, type MatrixApiError } from "../utils/errors";

export function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function parseJsonBody(request: Request): Promise<JsonBodyParseResult> {
  const body = await request.arrayBuffer();

  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body);
  } catch {
    return { ok: false, reason: "not_json" };
  }

  try {
    return { ok: true, value: JSON.parse(decoded) as unknown };
  } catch {
    return { ok: false, reason: "bad_json" };
  }
}

export async function parseJsonObjectBody(
  request: Request,
): Promise<UnknownRecord | MatrixApiError> {
  const parsed = await parseJsonBody(request);
  if (!parsed.ok) {
    return parsed.reason === "not_json"
      ? Errors.notJson("Request body is not valid UTF-8 JSON")
      : Errors.badJson();
  }

  if (!isRecord(parsed.value)) {
    return Errors.badJson();
  }

  return parsed.value;
}

export function requireEnumValue<const Values extends readonly string[]>(
  value: unknown,
  param: string,
  allowedValues: Values,
): Values[number] | MatrixApiError {
  if (typeof value !== "string") {
    return Errors.missingParam(param);
  }

  if (!allowedValues.includes(value)) {
    return Errors.invalidParam(
      param,
      `Invalid ${param}: ${value}. Must be one of: ${allowedValues.join(", ")}`,
    );
  }

  return value as Values[number];
}
