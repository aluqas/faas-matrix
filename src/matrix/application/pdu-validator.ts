import { Effect, Schema } from "effect";
import { getDefaultRoomVersion, getRoomVersion } from "../../services/room-versions";
import type { PDU } from "../../types";
import { ErrorCodes } from "../../types";
import { calculateReferenceHashEventId } from "../../utils/crypto";
import { MatrixApiError } from "../../utils/errors";
import { DomainError, toMatrixApiError } from "./domain-error";
import { runFederationEffect } from "./effect-runtime";

const UnknownRecordSchema = Schema.Record({ key: Schema.String, value: Schema.Unknown });
const StringRecordSchema = Schema.Record({ key: Schema.String, value: Schema.String });

const IncomingPduSchema = Schema.Struct({
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

type IncomingPdu = Schema.Schema.Type<typeof IncomingPduSchema>;

export function roomVersionRequiresIntegerJsonNumbers(roomVersion?: string): boolean {
  const numericVersion = Number(roomVersion ?? getDefaultRoomVersion());
  return Number.isInteger(numericVersion) && numericVersion >= 6;
}

export function findInvalidCanonicalJsonNumberPath(
  value: unknown,
  path: string = "$",
): string | null {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      return path;
    }
    return null;
  }

  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      const invalidPath = findInvalidCanonicalJsonNumberPath(entry, `${path}[${index}]`);
      if (invalidPath) {
        return invalidPath;
      }
    }
    return null;
  }

  if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      const invalidPath = findInvalidCanonicalJsonNumberPath(entry, `${path}.${key}`);
      if (invalidPath) {
        return invalidPath;
      }
    }
  }

  return null;
}

function toIncomingPdu(event: IncomingPdu, eventId: string): PDU {
  return {
    event_id: eventId,
    room_id: event.room_id,
    sender: event.sender,
    type: event.type ?? event.event_type ?? "",
    origin: event.origin,
    membership: event.membership,
    ...(event.prev_state ? { prev_state: [...event.prev_state] } : {}),
    state_key: event.state_key,
    content: event.content ?? {},
    origin_server_ts: event.origin_server_ts,
    depth: event.depth ?? 0,
    auth_events: [...(event.auth_events ?? [])],
    prev_events: [...(event.prev_events ?? [])],
    unsigned: event.unsigned,
    hashes: event.hashes,
    signatures: event.signatures,
  };
}

export function validateIncomingPduEffect(
  event: unknown,
  context?: string,
  roomVersion?: string,
): Effect.Effect<PDU, DomainError> {
  return Schema.decodeUnknown(IncomingPduSchema)(event).pipe(
    Effect.mapError(
      (error) =>
        new DomainError({
          kind: "spec_violation",
          errcode: ErrorCodes.M_BAD_JSON,
          message: `${context ?? "PDU"}: ${error.message}`,
          status: 400,
        }),
    ),
    Effect.flatMap((decoded) => {
      const type = decoded.type ?? decoded.event_type;
      if (!type) {
        return Effect.fail(
          new DomainError({
            kind: "spec_violation",
            errcode: ErrorCodes.M_BAD_JSON,
            message: `${context ?? "PDU"}: missing type`,
            status: 400,
          }),
        );
      }

      if (roomVersionRequiresIntegerJsonNumbers(roomVersion)) {
        const invalidNumberPath = findInvalidCanonicalJsonNumberPath(event);
        if (invalidNumberPath) {
          return Effect.fail(
            new DomainError({
              kind: "spec_violation",
              errcode: ErrorCodes.M_BAD_JSON,
              message: `${context ?? "PDU"}: invalid canonical JSON number at ${invalidNumberPath}`,
              status: 400,
            }),
          );
        }
      }

      const eventIdFormat = getRoomVersion(roomVersion ?? getDefaultRoomVersion())?.eventIdFormat;
      if (eventIdFormat === "v1") {
        if (!decoded.event_id) {
          return Effect.fail(
            new DomainError({
              kind: "spec_violation",
              errcode: ErrorCodes.M_BAD_JSON,
              message: `${context ?? "PDU"}: missing event_id`,
              status: 400,
            }),
          );
        }

        return Effect.succeed(toIncomingPdu(decoded, decoded.event_id));
      }

      return Effect.tryPromise({
        try: async () => {
          const eventId =
            decoded.event_id ??
            (await calculateReferenceHashEventId(
              {
                ...decoded,
                type,
              } as unknown as Record<string, unknown>,
              roomVersion,
            ));
          return toIncomingPdu(decoded, eventId);
        },
        catch: () =>
          new DomainError({
            kind: "spec_violation",
            errcode: ErrorCodes.M_BAD_JSON,
            message: `${context ?? "PDU"}: invalid event_id`,
            status: 400,
          }),
      });
    }),
  );
}

/**
 * Validate an incoming PDU (from federation) for required fields.
 * Throws MatrixApiError on validation failure so callers get a standardized error.
 */
export async function validateIncomingPdu(
  event: unknown,
  context?: string,
  roomVersion?: string,
): Promise<PDU> {
  try {
    return await runFederationEffect(validateIncomingPduEffect(event, context, roomVersion));
  } catch (error) {
    if (error instanceof DomainError) {
      throw toMatrixApiError(error);
    }
    throw new MatrixApiError("M_BAD_JSON", `${context ?? "PDU"}: malformed PDU`);
  }
}

/**
 * Filter-style variant: returns null for malformed events instead of throwing.
 * Useful when processing batches where individual malformed events should be skipped.
 */
export async function tryValidateIncomingPdu(
  event: unknown,
  context?: string,
  roomVersion?: string,
): Promise<PDU | null> {
  return await runFederationEffect(
    validateIncomingPduEffect(event, context, roomVersion).pipe(
      Effect.match({
        onSuccess: (validated) => validated,
        onFailure: () => null,
      }),
    ),
  );
}
