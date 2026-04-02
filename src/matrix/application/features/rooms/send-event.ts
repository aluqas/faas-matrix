import type { MembershipRecord } from "../../../repositories/interfaces";
import { getRoomVersion } from "../../../../services/room-versions";
import type { PDU } from "../../../../types";
import { Errors } from "../../../../utils/errors";
import {
  calculateContentHash,
  calculateReferenceHashEventId,
  canonicalJson,
} from "../../../../utils/crypto";
import { authorizeOwnedStateEvent } from "../owned-state/policy";
import { requireRoomVersionPolicy } from "../../room-version-policy";
import {
  getPowerLevelsContent,
  getRequiredEventPowerLevel,
  getUserPowerLevel,
} from "./power-levels";

function withOptionalValue<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  if (value === undefined) {
    return {};
  }

  return { [key]: value } as { [P in K]?: V };
}

export function hasEquivalentStateEvent(
  existingStateEvent: PDU | null,
  userId: string,
  content: Record<string, unknown>,
): existingStateEvent is PDU {
  return Boolean(
    existingStateEvent &&
    existingStateEvent.sender === userId &&
    canonicalJson(existingStateEvent.content) === canonicalJson(content),
  );
}

export function assertRedactionAllowed(input: {
  powerLevelsEvent: PDU | null;
  targetEvent: PDU | null;
  roomId: string;
  userId: string;
}): void {
  const powerLevels = getPowerLevelsContent(input.powerLevelsEvent);
  const userPower = getUserPowerLevel(powerLevels, input.userId);
  const redactPower = powerLevels.redact ?? 50;
  const isOwnEvent =
    input.targetEvent?.room_id === input.roomId && input.targetEvent.sender === input.userId;

  if (!isOwnEvent && userPower < redactPower) {
    throw Errors.forbidden("Insufficient power level to redact");
  }
}

export function assertOwnedStateEventAllowed(input: {
  roomVersion: string;
  powerLevelsEvent: PDU | null;
  eventType: string;
  stateKey: string;
  senderUserId: string;
}): void {
  const powerLevels = getPowerLevelsContent(input.powerLevelsEvent);

  authorizeOwnedStateEvent({
    policy: requireRoomVersionPolicy(input.roomVersion),
    eventType: input.eventType,
    stateKey: input.stateKey,
    senderUserId: input.senderUserId,
    actorPower: getUserPowerLevel(powerLevels, input.senderUserId),
    requiredEventPower: getRequiredEventPowerLevel(
      powerLevels,
      input.eventType,
      input.stateKey !== undefined,
    ),
  });
}

export async function buildRoomEvent(input: {
  roomId: string;
  userId: string;
  roomVersion: string;
  eventType: string;
  stateKey?: string;
  txnId: string;
  content: Record<string, unknown>;
  redacts?: string;
  membership: MembershipRecord | null;
  createEvent: PDU | null;
  powerLevelsEvent: PDU | null;
  latestEvents: PDU[];
  serverName: string;
  generateEventId: (serverName: string, roomVersion?: string) => Promise<string>;
  now: () => number;
}): Promise<PDU> {
  const authEvents: string[] = [];
  if (input.createEvent) authEvents.push(input.createEvent.event_id);
  if (input.powerLevelsEvent) authEvents.push(input.powerLevelsEvent.event_id);
  if (input.membership) authEvents.push(input.membership.eventId);

  const baseEvent = {
    room_id: input.roomId,
    sender: input.userId,
    type: input.eventType,
    ...withOptionalValue("state_key", input.stateKey),
    ...withOptionalValue("redacts", input.redacts),
    content: input.content,
    origin_server_ts: input.now(),
    unsigned: { transaction_id: input.txnId },
    depth: (input.latestEvents[0]?.depth ?? 0) + 1,
    auth_events: authEvents,
    prev_events: input.latestEvents.map((eventRecord) => eventRecord.event_id),
  };
  const hash = await calculateContentHash(baseEvent as unknown as Record<string, unknown>);
  const eventWithHash = {
    ...baseEvent,
    hashes: { sha256: hash },
  };
  const eventId =
    getRoomVersion(input.roomVersion)?.eventIdFormat === "v1"
      ? await input.generateEventId(input.serverName, input.roomVersion)
      : await calculateReferenceHashEventId(
          eventWithHash as unknown as Record<string, unknown>,
          input.roomVersion,
        );

  return {
    event_id: eventId,
    ...eventWithHash,
  };
}
