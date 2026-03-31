import { Effect, Schema } from "effect";
import type { PDU } from "../../types";
import { ErrorCodes } from "../../types";
import { extractServerNameFromMatrixId } from "../../utils/matrix-ids";
import { DomainError } from "./domain-error";
import { requireRoomVersionPolicy } from "./room-version-policy";

const UnknownRecordSchema = Schema.Record({ key: Schema.String, value: Schema.Unknown });
const StringRecordSchema = Schema.Record({ key: Schema.String, value: Schema.String });

export const FederationPduEnvelopeSchema = Schema.Struct({
  event_id: Schema.optional(Schema.String),
  room_id: Schema.optional(Schema.String),
  sender: Schema.String,
  type: Schema.String,
  state_key: Schema.optional(Schema.String),
  content: Schema.optional(UnknownRecordSchema),
  origin_server_ts: Schema.optional(Schema.Number),
  unsigned: Schema.optional(UnknownRecordSchema),
  depth: Schema.optional(Schema.Number),
  auth_events: Schema.optional(Schema.Array(Schema.String)),
  prev_events: Schema.optional(Schema.Array(Schema.String)),
  hashes: Schema.optional(Schema.Struct({ sha256: Schema.String })),
  signatures: Schema.optional(Schema.Record({ key: Schema.String, value: StringRecordSchema })),
  redacts: Schema.optional(Schema.String),
});

export type FederationPduEnvelope = Schema.Schema.Type<typeof FederationPduEnvelopeSchema>;

const FederationInviteEnvelopeSchema = Schema.Struct({
  room_version: Schema.optional(Schema.String),
  event: Schema.optional(Schema.Unknown),
  invite_room_state: Schema.optional(Schema.Array(Schema.Unknown)),
});

const FederationThirdPartyInviteSignedSchema = Schema.Struct({
  mxid: Schema.String,
  token: Schema.String,
  signatures: Schema.Record({ key: Schema.String, value: StringRecordSchema }),
});

const FederationThirdPartyInviteContentSchema = Schema.Struct({
  membership: Schema.String,
  third_party_invite: Schema.optional(
    Schema.Struct({
      display_name: Schema.optional(Schema.String),
      signed: FederationThirdPartyInviteSignedSchema,
    }),
  ),
});

const FederationThirdPartyInviteExchangeSchema = Schema.Struct({
  type: Schema.String,
  room_id: Schema.String,
  sender: Schema.String,
  state_key: Schema.String,
  content: FederationThirdPartyInviteContentSchema,
  origin_server_ts: Schema.optional(Schema.Number),
  depth: Schema.optional(Schema.Number),
  auth_events: Schema.optional(Schema.Array(Schema.String)),
  prev_events: Schema.optional(Schema.Array(Schema.String)),
  event_id: Schema.optional(Schema.String),
  signatures: Schema.optional(Schema.Record({ key: Schema.String, value: StringRecordSchema })),
});

export interface FederationValidationResult {
  roomId: string;
  eventId: string;
  event: PDU;
}

export interface FederationInviteValidationResult extends FederationValidationResult {
  roomVersion: string;
  inviteRoomState: unknown[];
  invitedUserId: string;
}

export interface FederationThirdPartyInviteValidationResult {
  roomId: string;
  sender: string;
  stateKey: string;
  eventId?: string;
  signed: {
    mxid: string;
    token: string;
    signatures: Record<string, Record<string, string>>;
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
  return {
    event_id: envelope.event_id ?? eventId,
    room_id: envelope.room_id ?? roomId,
    sender: envelope.sender,
    type: envelope.type,
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
  roomId: string;
  eventId: string;
  expectedMembership: "join" | "leave" | "knock";
  context: string;
  mismatchMessage: string;
}): Effect.Effect<FederationValidationResult, DomainError> {
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
  roomId: string;
  eventId: string;
}): Effect.Effect<FederationValidationResult, DomainError> {
  return validateMembershipEventRequest({
    ...input,
    expectedMembership: "join",
    context: "Malformed send_join event",
    mismatchMessage: "Only join membership events are accepted via send_join",
  });
}

export function validateSendLeaveRequest(input: {
  body: unknown;
  roomId: string;
  eventId: string;
}): Effect.Effect<FederationValidationResult, DomainError> {
  return validateMembershipEventRequest({
    ...input,
    expectedMembership: "leave",
    context: "Malformed send_leave event",
    mismatchMessage: "Event is not a leave event",
  });
}

export function validateSendKnockRequest(input: {
  body: unknown;
  roomId: string;
  eventId: string;
}): Effect.Effect<FederationValidationResult, DomainError> {
  return validateMembershipEventRequest({
    ...input,
    expectedMembership: "knock",
    context: "Malformed send_knock event",
    mismatchMessage: "Event is not a knock event",
  });
}

export function validateInviteRequest(input: {
  body: unknown;
  eventId: string;
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
      if (!event.state_key || !event.state_key.includes(":")) {
        return Effect.fail(invalidParam("Invalid state_key for invite"));
      }
      const invitedServer = extractServerNameFromMatrixId(event.state_key);
      if (invitedServer !== input.serverName) {
        return Effect.fail(forbidden("User is not local to this server"));
      }
      return Effect.succeed({
        roomId: event.room_id,
        eventId: input.eventId,
        roomVersion,
        event,
        inviteRoomState: Array.from(envelope.invite_room_state ?? []),
        invitedUserId: event.state_key,
      });
    }),
  );
}

export function validateThirdPartyInviteExchangeRequest(input: {
  body: unknown;
  roomId: string;
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
