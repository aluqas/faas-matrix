import type { AccountDataContent } from "../../shared/types/account-data";

export function encodeAccountDataContentResponse(content: AccountDataContent): AccountDataContent {
  return content;
}

export function encodeEmptyAccountDataResponse(): Record<string, never> {
  return {};
}
