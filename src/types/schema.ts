import { Schema } from "effect";

export const UnknownRecordSchema = Schema.Record({ key: Schema.String, value: Schema.Unknown });
export const StringRecordSchema = Schema.Record({ key: Schema.String, value: Schema.String });

export const InitialStateEventSchema = Schema.Struct({
  type: Schema.String,
  state_key: Schema.optional(Schema.String),
  content: UnknownRecordSchema,
});

export const CreateRoomRequestSchema = Schema.Struct({
  room_alias_local_part: Schema.optional(Schema.String),
  room_alias_name: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  topic: Schema.optional(Schema.String),
  invite: Schema.optional(Schema.Array(Schema.String)),
  room_version: Schema.optional(Schema.String),
  creation_content: Schema.optional(UnknownRecordSchema),
  initial_state: Schema.optional(Schema.Array(InitialStateEventSchema)),
  preset: Schema.optional(Schema.String),
  is_direct: Schema.optional(Schema.Boolean),
  visibility: Schema.optional(Schema.String),
});

export const JoinRoomRequestSchema = Schema.Struct({
  roomId: Schema.String,
  remoteServers: Schema.optional(Schema.Array(Schema.String)),
  content: Schema.optional(UnknownRecordSchema),
});

export const InviteRoomRequestSchema = Schema.Struct({
  roomId: Schema.String,
  targetUserId: Schema.String,
});

export const ModerationRequestSchema = Schema.Struct({
  roomId: Schema.String,
  targetUserId: Schema.String,
  reason: Schema.optional(Schema.String),
});

export type ValidatedCreateRoomRequest = Schema.Schema.Type<typeof CreateRoomRequestSchema>;
export type ValidatedJoinRoomSchemaInput = Schema.Schema.Type<typeof JoinRoomRequestSchema>;
export type ValidatedInviteRoomRequest = Schema.Schema.Type<typeof InviteRoomRequestSchema>;
export type ValidatedModerationRequest = Schema.Schema.Type<typeof ModerationRequestSchema>;

export const FederationPduEnvelopeSchema = Schema.Struct({
  event_id: Schema.optional(Schema.String),
  room_id: Schema.optional(Schema.String),
  sender: Schema.String,
  type: Schema.String,
  origin: Schema.optional(Schema.String),
  membership: Schema.optional(Schema.Literal("join", "invite", "leave", "ban", "knock")),
  prev_state: Schema.optional(Schema.Array(Schema.String)),
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

export const FederationInviteEnvelopeSchema = Schema.Struct({
  room_version: Schema.optional(Schema.String),
  event: Schema.optional(Schema.Unknown),
  invite_room_state: Schema.optional(Schema.Array(Schema.Unknown)),
});

export const FederationThirdPartyInviteSignedSchema = Schema.Struct({
  mxid: Schema.String,
  token: Schema.String,
  signatures: Schema.Record({ key: Schema.String, value: StringRecordSchema }),
});

export const FederationThirdPartyInviteContentSchema = Schema.Struct({
  membership: Schema.String,
  third_party_invite: Schema.optional(
    Schema.Struct({
      display_name: Schema.optional(Schema.String),
      signed: FederationThirdPartyInviteSignedSchema,
    }),
  ),
});

export const FederationThirdPartyInviteExchangeSchema = Schema.Struct({
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

export const IncomingPduSchema = Schema.Struct({
  event_id: Schema.optional(Schema.String),
  room_id: Schema.String,
  sender: Schema.String,
  type: Schema.optional(Schema.String),
  event_type: Schema.optional(Schema.String),
  origin: Schema.optional(Schema.String),
  membership: Schema.optional(Schema.Literal("join", "invite", "leave", "ban", "knock")),
  prev_state: Schema.optional(Schema.Array(Schema.String)),
  state_key: Schema.optional(Schema.String),
  content: Schema.optional(UnknownRecordSchema),
  origin_server_ts: Schema.Number,
  unsigned: Schema.optional(UnknownRecordSchema),
  depth: Schema.optional(Schema.Number),
  auth_events: Schema.optional(Schema.Array(Schema.String)),
  prev_events: Schema.optional(Schema.Array(Schema.String)),
  hashes: Schema.optional(Schema.Struct({ sha256: Schema.String })),
  signatures: Schema.optional(Schema.Record({ key: Schema.String, value: StringRecordSchema })),
});

export type IncomingPdu = Schema.Schema.Type<typeof IncomingPduSchema>;
