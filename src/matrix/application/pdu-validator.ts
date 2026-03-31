import { Effect, Schema } from "effect";
import type { PDU } from "../../types";
import { ErrorCodes } from "../../types";
import { MatrixApiError } from "../../utils/errors";
import { DomainError, toMatrixApiError } from "./domain-error";

const UnknownRecordSchema = Schema.Record({ key: Schema.String, value: Schema.Unknown });
const StringRecordSchema = Schema.Record({ key: Schema.String, value: Schema.String });

const IncomingPduSchema = Schema.Struct({
  event_id: Schema.String,
  room_id: Schema.String,
  sender: Schema.String,
  type: Schema.optional(Schema.String),
  event_type: Schema.optional(Schema.String),
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

function toIncomingPdu(event: IncomingPdu): PDU {
  return {
    event_id: event.event_id,
    room_id: event.room_id,
    sender: event.sender,
    type: event.type ?? event.event_type ?? "",
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

      return Effect.succeed(toIncomingPdu(decoded));
    }),
  );
}

/**
 * Validate an incoming PDU (from federation) for required fields.
 * Throws MatrixApiError on validation failure so callers get a standardized error.
 */
export function validateIncomingPdu(event: unknown, context?: string): PDU {
  try {
    return Effect.runSync(validateIncomingPduEffect(event, context));
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
export function tryValidateIncomingPdu(event: unknown, context?: string): PDU | null {
  try {
    return validateIncomingPdu(event, context);
  } catch {
    return null;
  }
}
