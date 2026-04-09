import {
  getNextNamedStreamPosition,
  insertToDeviceMessage,
  listUserDeviceIds,
} from "../../infra/repositories/to-device-repository";
import type { DirectToDeviceEduContent } from "./contracts";

export async function ingestDirectToDeviceEdu(
  db: D1Database,
  origin: string,
  content: DirectToDeviceEduContent,
): Promise<void> {
  const sender = typeof content.sender === "string" ? content.sender : origin;
  const eventType = typeof content.type === "string" ? content.type : undefined;
  const messageId = typeof content.message_id === "string" ? content.message_id : undefined;
  const messages = content.messages;

  if (!eventType || !messageId || !messages) {
    return;
  }

  for (const [recipientUserId, deviceMessages] of Object.entries(messages)) {
    if (!deviceMessages || typeof deviceMessages !== "object") {
      continue;
    }

    for (const [deviceId, messageContent] of Object.entries(deviceMessages)) {
      const targetDevices =
        deviceId === "*"
          ? await listUserDeviceIds(db, recipientUserId as import("../../shared/types").UserId)
          : [deviceId];

      for (const targetDeviceId of targetDevices) {
        const streamPosition = await getNextNamedStreamPosition(db, "to_device");
        await insertToDeviceMessage(db, {
          recipientUserId,
          recipientDeviceId: targetDeviceId,
          senderUserId: sender,
          eventType,
          content:
            messageContent && typeof messageContent === "object"
              ? (messageContent)
              : {},
          messageId,
          streamPosition,
        });
      }
    }
  }
}
