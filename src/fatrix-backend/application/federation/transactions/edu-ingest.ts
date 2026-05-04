import { Effect } from "effect";
import type { AppContext } from "../../../ports/runtime/app-context";
import type { FederationRepository } from "../../../ports/repositories";
import { createServerAclPolicy } from "../../features/server-acl/policy";
import type { PresenceEduContent } from "../../features/presence/contracts";
import type { TypingEduContent } from "../../features/typing/contracts";
import type { DirectToDeviceEduContent } from "../../features/to-device/contracts";
import { fromInfraVoid } from "../../effect/infra-effect";
import { emitEffectWarningEffect } from "../../runtime/effect-debug";
import { handleFederationDeviceListEdu } from "../../orchestrators/federation-handler-service";
import { ingestPresenceEduEffect } from "../../features/presence/ingest";
import { ingestTypingEduEffect, type TypingIngestEffectPorts } from "../../features/typing/ingest";
import { ingestReceiptEduEffect } from "../../features/receipts/ingest";
import type { ReceiptIngestPorts } from "../../features/receipts/ingest";
import {
  getRoomScopedEduRoomIds,
  toRawFederationEdu,
  type EduIngestInput,
  type EduIngestResult,
} from "./contracts";
import { toRoomId } from "../../../../fatrix-model/utils/ids";

export interface EduIngestPorts {
  appContext: AppContext;
  repository: FederationRepository;
  eduHandlers: FederationEduHandlers;
  runEffect<A, E>(effect: Effect.Effect<A, E>): Promise<A>;
}

export interface FederationEduHandlers {
  typing: TypingIngestEffectPorts;
  receipts: ReceiptIngestPorts;
  directToDevice: {
    ingest(origin: string, content: DirectToDeviceEduContent): Promise<void>;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPresenceEduContent(
  content: Record<string, unknown>,
): content is Record<string, unknown> & PresenceEduContent {
  return Array.isArray(content["push"]);
}

function isTypingEduContent(
  content: Record<string, unknown>,
): content is Record<string, unknown> & TypingEduContent {
  return (
    typeof content["room_id"] === "string" &&
    typeof content["user_id"] === "string" &&
    typeof content["typing"] === "boolean"
  );
}

function isDirectToDeviceEduContent(
  content: Record<string, unknown>,
): content is Record<string, unknown> & DirectToDeviceEduContent {
  return (
    typeof content["sender"] === "string" &&
    typeof content["type"] === "string" &&
    typeof content["message_id"] === "string" &&
    isRecord(content["messages"])
  );
}

export async function ingestFederationEdu(
  ports: EduIngestPorts,
  input: EduIngestInput,
): Promise<EduIngestResult> {
  const edu = toRawFederationEdu(input.rawEdu);
  const eduType = typeof edu.edu_type === "string" ? edu.edu_type : "";
  const content =
    edu.content && typeof edu.content === "object" && !Array.isArray(edu.content)
      ? edu.content
      : {};
  const roomIds = getRoomScopedEduRoomIds(eduType, content).flatMap((roomId) => {
    const typedRoomId = toRoomId(roomId);
    return typedRoomId ? [typedRoomId] : [];
  });

  for (const roomId of roomIds) {
    const room = await ports.repository.getRoom(roomId);
    if (!room) {
      continue;
    }

    const aclPolicy = createServerAclPolicy(await ports.repository.getRoomState(roomId));
    const userId = typeof content["user_id"] === "string" ? content["user_id"] : undefined;
    const aclDecision = aclPolicy.allowRoomScopedEdu(input.origin, {
      eduType,
      roomId,
      ...(userId ? { userId } : {}),
    });
    if (aclDecision.kind === "deny") {
      await ports.runEffect(
        emitEffectWarningEffect("[federation.edu] ACL rejected", {
          origin: input.origin,
          roomId,
          eduType,
          reason: aclDecision.reason,
        }),
      );
      return {
        kind: "rejected",
        eduType,
        roomIds,
        reason: aclDecision.reason,
      };
    }
  }

  switch (eduType) {
    case "m.presence": {
      if (isPresenceEduContent(content)) {
        await ports.runEffect(
          ingestPresenceEduEffect(
            {
              presenceStore: {
                upsertPresence: (userId, presence, statusMessage, lastActiveTs, currentlyActive) =>
                  fromInfraVoid(
                    () =>
                      Promise.resolve(
                        ports.repository.upsertPresence(
                          userId,
                          presence,
                          statusMessage,
                          lastActiveTs,
                          currentlyActive,
                        ),
                      ),
                    "Failed to apply presence EDU",
                  ),
              },
            },
            ports.appContext.capabilities.clock.now(),
            content,
          ),
        );
      }
      break;
    }
    case "m.device_list_update": {
      await handleFederationDeviceListEdu(ports.repository, content);
      break;
    }
    case "m.typing": {
      if (isTypingEduContent(content)) {
        await ports.runEffect(
          ingestTypingEduEffect(input.origin, content, ports.eduHandlers.typing),
        );
      }
      break;
    }
    case "m.receipt": {
      await ports.runEffect(
        ingestReceiptEduEffect(ports.eduHandlers.receipts, {
          origin: input.origin,
          content,
        }),
      );
      break;
    }
    case "m.direct_to_device": {
      if (isDirectToDeviceEduContent(content)) {
        await ports.eduHandlers.directToDevice.ingest(input.origin, content);
      }
      break;
    }
    default:
      break;
  }

  const streamId = `${input.origin}:${eduType}:${ports.appContext.capabilities.clock.now()}`;
  await ports.repository.storeProcessedEdu(input.origin, eduType, {
    ...content,
    edu_id: streamId,
  });

  return {
    kind: "applied",
    eduType,
    roomIds,
  };
}
