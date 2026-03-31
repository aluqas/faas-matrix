import { extractServerNameFromMatrixId, isLocalMatrixId } from "../shared/matrix-id";
import type { ToDeviceCommandInput, ToDeviceCommandPorts, ToDeviceDispatchPlan } from "./contracts";

function ensureObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export async function dispatchToDeviceMessages(
  input: ToDeviceCommandInput,
  ports: ToDeviceCommandPorts,
): Promise<ToDeviceDispatchPlan> {
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
        entry.messages[recipientUserId] ||= {};
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
  console.log("[to-device] dispatch plan", {
    localMessages: localMessages.length,
    remoteMessages: remoteMessages.map((message) => ({
      destination: message.destination,
      recipients: Object.keys(message.messages),
    })),
  });
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

  return {
    localMessages,
    remoteMessages,
  };
}
