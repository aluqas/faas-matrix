import { Effect, Schema } from "effect";
import { ErrorCodes } from "../../types";
import {
  CreateRoomRequestSchema,
  InviteRoomRequestSchema,
  JoinRoomRequestSchema,
  ModerationRequestSchema,
  type ValidatedCreateRoomRequest,
  type ValidatedInviteRoomRequest,
  type ValidatedJoinRoomSchemaInput,
  type ValidatedModerationRequest,
} from "../../types/schema";
import { getDefaultRoomVersion } from "../../services/room-versions";
import { DomainError } from "./domain-error";
import { requireRoomVersionPolicy } from "./room-version-policy";
import { validateStateEvent } from "./rooms-support";
export type ValidatedJoinRoomRequest = {
  roomId: string;
  remoteServers: string[];
  content?: Record<string, unknown>;
};

const VALID_VISIBILITIES = new Set(["private", "public"]);
const VALID_PRESETS = new Set(["private_chat", "trusted_private_chat", "public_chat"]);

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

function decodeSchema<A>(
  schema: Schema.Schema<A>,
  input: unknown,
  message: string,
): Effect.Effect<A, DomainError> {
  return Schema.decodeUnknown(schema)(input).pipe(
    Effect.mapError((error) => malformed(`${message}: ${error.message}`)),
  );
}

function validateCreateRoomSemantics(
  request: ValidatedCreateRoomRequest,
): Effect.Effect<ValidatedCreateRoomRequest, DomainError> {
  return Effect.gen(function* () {
    if (
      request.room_alias_local_part !== undefined &&
      request.room_alias_local_part.trim().length === 0
    ) {
      yield* Effect.fail(invalidParam("room_alias_local_part must not be empty"));
    }

    if (request.room_alias_name !== undefined && request.room_alias_name.trim().length === 0) {
      yield* Effect.fail(invalidParam("room_alias_name must not be empty"));
    }

    if (
      request.room_alias_local_part !== undefined &&
      request.room_alias_name !== undefined &&
      request.room_alias_local_part !== request.room_alias_name
    ) {
      yield* Effect.fail(
        invalidParam("room_alias_local_part and room_alias_name must match when both provided"),
      );
    }

    if (request.visibility !== undefined && !VALID_VISIBILITIES.has(request.visibility)) {
      yield* Effect.fail(invalidParam("visibility must be one of: public, private"));
    }

    if (request.preset !== undefined && !VALID_PRESETS.has(request.preset)) {
      yield* Effect.fail(
        invalidParam("preset must be one of: private_chat, trusted_private_chat, public_chat"),
      );
    }

    if (request.initial_state !== undefined) {
      const encryptionEvents = request.initial_state.filter(
        (state) => state.type === "m.room.encryption",
      );
      if (encryptionEvents.length > 1) {
        yield* Effect.fail(
          invalidParam("Cannot specify multiple m.room.encryption events in initial_state"),
        );
      }

      for (const [index, stateEvent] of request.initial_state.entries()) {
        const validation = validateStateEvent(stateEvent, index);
        if (!validation.valid) {
          yield* Effect.fail(invalidParam(validation.error ?? "Invalid initial_state entry"));
        }
      }
    }

    try {
      requireRoomVersionPolicy(request.room_version ?? getDefaultRoomVersion());
    } catch (error) {
      if (error instanceof DomainError && error.kind === "incompatible_room_version") {
        yield* Effect.fail(
          new DomainError({
            kind: "unsupported_room_version",
            errcode: ErrorCodes.M_UNSUPPORTED_ROOM_VERSION,
            message: error.message,
            status: error.status,
          }),
        );
      }
      yield* Effect.fail(error as DomainError);
    }

    return request;
  });
}

export function validateCreateRoomRequest(
  body: unknown,
): Effect.Effect<ValidatedCreateRoomRequest, DomainError> {
  return decodeSchema(CreateRoomRequestSchema, body, "Malformed createRoom request").pipe(
    Effect.flatMap(validateCreateRoomSemantics),
  );
}

export function validateJoinRoomRequest(input: {
  roomId: string;
  remoteServers?: string[];
  content?: Record<string, unknown>;
}): Effect.Effect<ValidatedJoinRoomRequest, DomainError> {
  return decodeSchema(JoinRoomRequestSchema, input, "Malformed joinRoom request").pipe(
    Effect.flatMap((request) =>
      Effect.gen(function* () {
        const validated = request as ValidatedJoinRoomSchemaInput;
        if (!validated.roomId.startsWith("!")) {
          yield* Effect.fail(invalidParam("roomId must be a room ID"));
        }

        const remoteServers = Array.from(
          new Set(
            (validated.remoteServers ?? [])
              .map((server) => server.trim())
              .filter((server) => server.length > 0),
          ),
        );

        return {
          roomId: validated.roomId,
          remoteServers,
          ...(validated.content !== undefined ? { content: validated.content } : {}),
        };
      }),
    ),
  );
}

export function validateInviteRoomRequest(input: {
  roomId: string;
  targetUserId: string;
}): Effect.Effect<ValidatedInviteRoomRequest, DomainError> {
  return decodeSchema(InviteRoomRequestSchema, input, "Malformed invite request").pipe(
    Effect.flatMap((request) =>
      Effect.gen(function* () {
        if (!request.roomId.startsWith("!")) {
          yield* Effect.fail(invalidParam("roomId must be a room ID"));
        }
        if (!request.targetUserId.startsWith("@") || !request.targetUserId.includes(":")) {
          yield* Effect.fail(invalidParam("user_id must be a Matrix user ID"));
        }
        return request;
      }),
    ),
  );
}

export function validateModerationRequest(input: {
  roomId: string;
  targetUserId: string;
  reason?: string;
}): Effect.Effect<ValidatedModerationRequest, DomainError> {
  return decodeSchema(ModerationRequestSchema, input, "Malformed moderation request").pipe(
    Effect.flatMap((request) =>
      Effect.gen(function* () {
        if (!request.roomId.startsWith("!")) {
          yield* Effect.fail(invalidParam("roomId must be a room ID"));
        }
        if (!request.targetUserId.startsWith("@") || !request.targetUserId.includes(":")) {
          yield* Effect.fail(invalidParam("user_id must be a Matrix user ID"));
        }
        return request;
      }),
    ),
  );
}
