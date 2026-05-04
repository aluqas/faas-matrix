import { Effect } from "effect";
import type { ToDeviceRequest } from "../../../fatrix-model/types/client";
import type { UserId } from "../../../fatrix-model/types";
import { Errors, MatrixApiError } from "../../../fatrix-model/utils/errors";
import { parseUserIdLike } from "../../../fatrix-model/utils/ids";
import type { ToDeviceCommandInput } from "../../../fatrix-backend/application/features/to-device/contracts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function decodeSendToDeviceInput(input: {
  authUserId: string;
  eventType: string;
  txnId: string;
  body: unknown;
}): Effect.Effect<ToDeviceCommandInput, MatrixApiError> {
  return Effect.gen(function* () {
    const userId = parseUserIdLike(input.authUserId);
    if (!userId) {
      return yield* Effect.fail(Errors.unknownToken());
    }

    if (!isRecord(input.body)) {
      return yield* Effect.fail(Errors.badJson());
    }

    const messages = input.body["messages"];
    if (!isRecord(messages)) {
      return yield* Effect.fail(Errors.missingParam("messages"));
    }

    const normalizedMessages: ToDeviceRequest["messages"] = {};
    for (const [recipientUserId, deviceMap] of Object.entries(messages)) {
      if (!isRecord(deviceMap)) {
        continue;
      }

      normalizedMessages[recipientUserId as UserId] = {};
      for (const [deviceId, content] of Object.entries(deviceMap)) {
        normalizedMessages[recipientUserId as UserId][deviceId] = isRecord(content) ? content : {};
      }
    }

    return {
      senderUserId: userId,
      eventType: input.eventType,
      txnId: input.txnId,
      messages: normalizedMessages,
    };
  });
}
