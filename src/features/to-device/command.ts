import { Effect } from "effect";
import { extractServerNameFromMatrixId, isLocalMatrixId } from "../shared/matrix-id";
import { runClientEffect } from "../../matrix/application/runtime/effect-runtime";
import { withLogContext } from "../../matrix/application/logging";
import { Errors, MatrixApiError } from "../../shared/utils/errors";
import { InfraError } from "../../matrix/application/domain-error";
import type { ToDeviceCommandInput, ToDeviceCommandPorts, ToDeviceDispatchPlan } from "./contracts";

function ensureObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export async function dispatchToDeviceMessages(
  input: ToDeviceCommandInput,
  ports: ToDeviceCommandPorts,
): Promise<ToDeviceDispatchPlan> {
  const logger = withLogContext({
    component: "to-device",
    operation: "command",
    user_id: input.senderUserId,
    txn_id: input.txnId,
    debugEnabled: ports.debugEnabled,
  });
  await runClientEffect(
    logger.info("to_device.command.start", {
      recipient_count: Object.keys(input.messages).length,
      event_type: input.eventType,
    }),
  );

  const localMessages: ToDeviceDispatchPlan["localMessages"] = [];
  const remoteMessageMap = new Map<
    string,
    {
      destination: string;
      senderUserId: string;
      eventType: string;
      messageId: string;
      messages: Record<string, Record<string, Record<string, unknown>>>;
    }
  >();

  for (const [recipientUserId, deviceMessages] of Object.entries(input.messages)) {
    const recipientServer = extractServerNameFromMatrixId(recipientUserId);
    if (!recipientServer) {
      continue;
    }

    for (const [deviceId, rawContent] of Object.entries(deviceMessages)) {
      const content = ensureObject(rawContent);

      if (!isLocalMatrixId(recipientUserId, ports.localServerName)) {
        const messageId = `${input.txnId}-${recipientServer}`.slice(0, 32);
        const entry = remoteMessageMap.get(recipientServer) ?? {
          destination: recipientServer,
          senderUserId: input.senderUserId,
          eventType: input.eventType,
          messageId,
          messages: {},
        };
        entry.messages[recipientUserId] ??= {};
        entry.messages[recipientUserId][deviceId] = content;
        remoteMessageMap.set(recipientServer, entry);
        continue;
      }

      const targetDevices =
        deviceId === "*" ? await ports.getUserDevices(recipientUserId) : [deviceId];

      for (const targetDeviceId of targetDevices) {
        localMessages.push({
          recipientUserId,
          recipientDeviceId: targetDeviceId,
          senderUserId: input.senderUserId,
          eventType: input.eventType,
          content,
          messageId:
            `${input.senderUserId}_${input.txnId}_${recipientUserId}_${targetDeviceId}`.slice(
              0,
              255,
            ),
        });
      }
    }
  }

  for (const message of localMessages) {
    const streamPosition = await ports.nextStreamPosition("to_device");
    await ports.storeLocalMessage({
      ...message,
      streamPosition,
    });
  }

  const remoteMessages = Array.from(remoteMessageMap.values());
  await runClientEffect(
    logger.debug("to_device.command.dispatch_plan", {
      local_message_count: localMessages.length,
      remote_batch_count: remoteMessages.length,
      remote_destinations: remoteMessages.map((message) => message.destination),
    }),
  );
  await Promise.all(
    remoteMessages.map((remoteMessage) =>
      ports.queueEdu(remoteMessage.destination, {
        sender: remoteMessage.senderUserId,
        type: remoteMessage.eventType,
        message_id: remoteMessage.messageId,
        messages: remoteMessage.messages,
      }),
    ),
  );
  await runClientEffect(
    logger.info("to_device.command.success", {
      local_message_count: localMessages.length,
      remote_batch_count: remoteMessages.length,
    }),
  );

  return {
    localMessages,
    remoteMessages,
  };
}

export interface ToDeviceRequestPorts {
  transactionStore: {
    getTransactionResponse(
      userId: string,
      txnId: string,
    ): Effect.Effect<Record<string, unknown> | null, InfraError>;
    storeTransactionResponse(
      userId: string,
      txnId: string,
      response: Record<string, unknown>,
    ): Effect.Effect<void, InfraError>;
  };
  dispatcher: {
    dispatch(input: ToDeviceCommandInput): Effect.Effect<ToDeviceDispatchPlan, InfraError>;
  };
}

export function sendToDeviceEffect(
  ports: ToDeviceRequestPorts,
  input: ToDeviceCommandInput,
): Effect.Effect<Record<string, unknown>, MatrixApiError | InfraError> {
  return Effect.gen(function* () {
    const existing = yield* ports.transactionStore.getTransactionResponse(input.senderUserId, input.txnId);
    if (existing) {
      return existing;
    }

    if (!input.messages) {
      return yield* Effect.fail(Errors.missingParam("messages"));
    }

    yield* ports.dispatcher.dispatch(input);
    const response: Record<string, unknown> = {};
    yield* ports.transactionStore.storeTransactionResponse(input.senderUserId, input.txnId, response);
    return response;
  });
}
