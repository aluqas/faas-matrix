import { Effect, Schema } from "effect";
import type { EventId, MatrixSignatures, PDU, RoomId, UserId } from "../../../fatrix-model/types";
import { ErrorCodes } from "../../../fatrix-model/types";
import {
  FederationInviteEnvelopeSchema,
  FederationPduEnvelopeSchema,
  FederationThirdPartyInviteExchangeSchema,
  type FederationPduEnvelope,
} from "../../../fatrix-model/types/schema";
import { extractServerNameFromMatrixId } from "../../../fatrix-model/utils/matrix-ids";
import { toEventId, toRoomId, toUserId } from "../../../fatrix-model/utils/ids";
import { DomainError } from "../domain-error";
import { requireRoomVersionPolicy } from "../room-version-policy";

export interface FederationEventValidationResult {
  roomId: RoomId;
  eventId: EventId;
  event: PDU;
}

export interface FederationInviteValidationResult extends FederationEventValidationResult {
  roomVersion: string;
  inviteRoomState: unknown[];
  invitedUserId: UserId;
}

export interface FederationThirdPartyInviteValidationResult {
  roomId: RoomId;
  sender: UserId;
  stateKey: UserId;
  eventId?: EventId;
  signed: {
    mxid: UserId;
    token: string;
    signatures: MatrixSignatures;
  };
  displayName?: string;
}

function malformed(message: string): DomainError {
  return new DomainError({
    kind: "spec_violation",
    errcode: ErrorCodes.M_BAD_JSON,
    message,
    status: 400,
  });
}

function invalidParam(message: string): DomainError {
  return new DomainError({
    kind: "spec_violation",
    errcode: ErrorCodes.M_INVALID_PARAM,
    message,
    status: 400,
  });
}

function forbidden(message: string): DomainError {
  return new DomainError({
    kind: "auth_violation",
    errcode: ErrorCodes.M_FORBIDDEN,
    message,
    status: 403,
  });
}

function missingParam(param: string): DomainError {
  return new DomainError({
    kind: "spec_violation",
    errcode: ErrorCodes.M_MISSING_PARAM,
    message: `Missing required parameter: ${param}`,
    status: 400,
  });
}

function decodeSchema<A>(
  schema: Schema.Schema<A>,
  input: unknown,
  message: string,
): Effect.Effect<A, DomainError> {
  return Schema.decodeUnknown(schema)(input).pipe(
    Effect.mapError((error) => malformed(`${message}: ${error.message}`)),
  );
}

function toPdu(envelope: FederationPduEnvelope, roomId: string, eventId: string): PDU {
  const resolvedEventId = toEventId(envelope.event_id ?? eventId);
  const resolvedRoomId = toRoomId(envelope.room_id ?? roomId);
  const resolvedSender = toUserId(envelope.sender);
  if (!resolvedEventId || !resolvedRoomId || !resolvedSender) {
    throw invalidParam("Invalid Matrix identifiers in federation event");
  }
  return {
    event_id: resolvedEventId,
    room_id: resolvedRoomId,
    sender: resolvedSender,
    type: envelope.type,
    origin: envelope.origin,
    membership: envelope.membership,
    ...(envelope.prev_state ? { prev_state: [...envelope.prev_state] } : {}),
    state_key: envelope.state_key,
    content: envelope.content ?? {},
    origin_server_ts: envelope.origin_server_ts ?? Date.now(),
    unsigned: envelope.unsigned,
    depth: envelope.depth ?? 0,
    auth_events: [...(envelope.auth_events ?? [])],
    prev_events: [...(envelope.prev_events ?? [])],
    hashes: envelope.hashes,
    signatures: envelope.signatures,
    redacts: envelope.redacts,
  };
}

function validateEventIdentity(
  event: PDU,
  roomId: string,
  eventId: string,
): Effect.Effect<void, DomainError> {
  return Effect.gen(function* () {
    if (event.event_id !== eventId) {
      yield* Effect.fail(invalidParam("Event ID mismatch"));
    }
    if (event.room_id !== roomId) {
      yield* Effect.fail(invalidParam("Room ID mismatch"));
    }
  });
}

function validateMembershipEventRequest(input: {
  body: unknown;
  roomId: RoomId;
  eventId: EventId;
  expectedMembership: "join" | "leave" | "knock";
  context: string;
  mismatchMessage: string;
}): Effect.Effect<FederationEventValidationResult, DomainError> {
  return decodeSchema(FederationPduEnvelopeSchema, input.body, input.context).pipe(
    Effect.map((envelope) => toPdu(envelope, input.roomId, input.eventId)),
    Effect.flatMap((event) =>
      validateEventIdentity(event, input.roomId, input.eventId).pipe(Effect.as(event)),
    ),
    Effect.flatMap((event) => {
      if (event.type !== "m.room.member" || event.content.membership !== input.expectedMembership) {
        return Effect.fail(invalidParam(input.mismatchMessage));
      }
      if (event.state_key !== event.sender) {
        return Effect.fail(
          invalidParam(
            `${input.expectedMembership[0].toUpperCase()}${input.expectedMembership.slice(1)} events must target the sending user`,
          ),
        );
      }
      return Effect.succeed({ roomId: input.roomId, eventId: input.eventId, event });
    }),
  );
}

export function validateSendJoinRequest(input: {
  body: unknown;
  roomId: RoomId;
  eventId: EventId;
}): Effect.Effect<FederationEventValidationResult, DomainError> {
  return validateMembershipEventRequest({
    ...input,
    expectedMembership: "join",
    context: "Malformed send_join event",
    mismatchMessage: "Only join membership events are accepted via send_join",
  });
}

export function validateSendLeaveRequest(input: {
  body: unknown;
  roomId: RoomId;
  eventId: EventId;
}): Effect.Effect<FederationEventValidationResult, DomainError> {
  return validateMembershipEventRequest({
    ...input,
    expectedMembership: "leave",
    context: "Malformed send_leave event",
    mismatchMessage: "Event is not a leave event",
  });
}

export function validateSendKnockRequest(input: {
  body: unknown;
  roomId: RoomId;
  eventId: EventId;
}): Effect.Effect<FederationEventValidationResult, DomainError> {
  return validateMembershipEventRequest({
    ...input,
    expectedMembership: "knock",
    context: "Malformed send_knock event",
    mismatchMessage: "Event is not a knock event",
  });
}

export function validateInviteRequest(input: {
  body: unknown;
  eventId: EventId;
  serverName: string;
  requireRoomVersion: boolean;
}): Effect.Effect<FederationInviteValidationResult, DomainError> {
  return decodeSchema(
    FederationInviteEnvelopeSchema,
    input.body,
    "Malformed federation invite request",
  ).pipe(
    Effect.flatMap((envelope) => {
      const roomVersion = envelope.room_version;
      if (input.requireRoomVersion && !roomVersion) {
        return Effect.fail(missingParam("room_version"));
      }
      if (roomVersion) {
        try {
          requireRoomVersionPolicy(roomVersion);
        } catch (error) {
          return Effect.fail(error as DomainError);
        }
      }

      const eventSource = envelope.event ?? input.body;
      return decodeSchema(FederationPduEnvelopeSchema, eventSource, "Malformed invite event").pipe(
        Effect.map((decodedEvent) => ({
          envelope,
          roomVersion: roomVersion ?? "10",
          event: toPdu(decodedEvent, decodedEvent.room_id ?? "", input.eventId),
        })),
      );
    }),
    Effect.flatMap(({ envelope, roomVersion, event }) =>
      validateEventIdentity(event, event.room_id, input.eventId).pipe(
        Effect.as({ envelope, roomVersion, event }),
      ),
    ),
    Effect.flatMap(({ envelope, roomVersion, event }) => {
      if (event.type !== "m.room.member" || event.content.membership !== "invite") {
        return Effect.fail(invalidParam("Event is not an invite event"));
      }
      const invitedUserId = event.state_key ? toUserId(event.state_key) : null;
      if (!invitedUserId) {
        return Effect.fail(invalidParam("Invalid state_key for invite"));
      }
      const invitedServer = extractServerNameFromMatrixId(invitedUserId);
      if (invitedServer !== input.serverName) {
        return Effect.fail(forbidden("User is not local to this server"));
      }
      return Effect.succeed({
        roomId: event.room_id,
        eventId: input.eventId,
        roomVersion,
        event,
        inviteRoomState: Array.from(envelope.invite_room_state ?? []),
        invitedUserId,
      });
    }),
  );
}

export function validateThirdPartyInviteExchangeRequest(input: {
  body: unknown;
  roomId: RoomId;
}): Effect.Effect<FederationThirdPartyInviteValidationResult, DomainError> {
  return decodeSchema(
    FederationThirdPartyInviteExchangeSchema,
    input.body,
    "Malformed third party invite exchange request",
  ).pipe(
    Effect.flatMap((body) => {
      if (body.type !== "m.room.member" || body.content.membership !== "invite") {
        return Effect.fail(invalidParam("Event must be a membership invite"));
      }

      if (body.room_id !== input.roomId) {
        return Effect.fail(invalidParam("Room ID mismatch"));
      }

      const thirdPartyInvite = body.content.third_party_invite;
      if (!thirdPartyInvite) {
        return Effect.fail(invalidParam("Missing third_party_invite or signed data"));
      }

      if (thirdPartyInvite.signed.mxid !== body.state_key) {
        return Effect.fail(invalidParam("mxid does not match state_key"));
      }

      return Effect.succeed({
        roomId: body.room_id,
        sender: body.sender,
        stateKey: body.state_key,
        eventId: body.event_id,
        signed: thirdPartyInvite.signed,
        displayName: thirdPartyInvite.display_name,
      });
    }),
  );
}
