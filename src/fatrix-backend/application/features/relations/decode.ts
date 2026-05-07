import { Effect } from "effect";
import type {
  EventRelationshipsRequest,
  RelationCursor,
} from "../../../../fatrix-model/types/events";
import type { RoomId, UserId } from "../../../../fatrix-model/types";
import { Errors, MatrixApiError } from "../../../../fatrix-model/utils/errors";
import {
  parseEventIdLike,
  parseRoomIdLike,
  parseUserIdLike,
} from "../../../../fatrix-model/utils/ids";
import { parseSyncToken } from "../sync/types/contracts";
import {
  type ListRelationsInput,
  type ListThreadsInput,
  type PutThreadSubscriptionInput,
  type QueryRelationsInput,
  type ThreadSubscriptionTargetInput,
} from "./query";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseRelationCursor(token: string | undefined): RelationCursor | null {
  if (!token) {
    return null;
  }

  if (token.startsWith("s")) {
    // Simple stream token "s14" — extract the numeric part directly.
    // parseSyncToken only handles canonical "s{N}_td{N}_dk{N}" format and
    // returns events=0 for plain "s14", so we must parse simple tokens first.
    const simpleMatch = token.match(/^s(\d+)$/);
    if (simpleMatch) {
      return {
        value: Number.parseInt(simpleMatch[1] ?? "0", 10),
        column: "stream_ordering",
      };
    }
    return {
      value: parseSyncToken(token).events,
      column: "stream_ordering",
    };
  }

  const parsed = Number.parseInt(token, 10);
  if (Number.isNaN(parsed)) {
    return null;
  }

  return {
    value: parsed,
    column: "origin_server_ts",
  };
}

function decodeAuthUserId(value: string): UserId | MatrixApiError {
  return parseUserIdLike(value) ?? Errors.invalidParam("userId", "Invalid user ID");
}

function decodeRoomId(value: string, param = "roomId"): RoomId | MatrixApiError {
  return parseRoomIdLike(value) ?? Errors.invalidParam(param, `Invalid ${param}`);
}

function decodeLimit(value: string | undefined, fallback: number, max: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.min(parsed, max);
}

export function decodeEventRelationshipsInput(input: {
  authUserId: string;
  body: unknown;
}): Effect.Effect<QueryRelationsInput, MatrixApiError> {
  return Effect.gen(function* () {
    const authUserId = decodeAuthUserId(input.authUserId);
    if (authUserId instanceof MatrixApiError) {
      return yield* Effect.fail(authUserId);
    }

    if (!isRecord(input.body) || typeof input.body.event_id !== "string") {
      return yield* Effect.fail(Errors.badJson());
    }

    const eventId = parseEventIdLike(input.body.event_id);
    const roomId =
      typeof input.body.room_id === "string" ? parseRoomIdLike(input.body.room_id) : undefined;
    if (!eventId) {
      return yield* Effect.fail(Errors.invalidParam("event_id", "Invalid event ID"));
    }
    if (typeof input.body.room_id === "string" && !roomId) {
      return yield* Effect.fail(Errors.invalidParam("room_id", "Invalid room ID"));
    }

    const direction = input.body.direction === "up" ? "up" : "down";
    const request: EventRelationshipsRequest = {
      eventId,
      ...(roomId ? { roomId } : {}),
      direction,
      ...(typeof input.body.include_parent === "boolean"
        ? { includeParent: input.body.include_parent }
        : {}),
      ...(typeof input.body.recent_first === "boolean"
        ? { recentFirst: input.body.recent_first }
        : {}),
      ...(typeof input.body.max_depth === "number" ? { maxDepth: input.body.max_depth } : {}),
    };

    return { authUserId, request };
  });
}

export function decodeListRelationsInput(input: {
  authUserId: string;
  roomId: string;
  eventId: string;
  relType?: string;
  eventType?: string;
  from?: string;
  limit?: string;
  dir?: string;
}): Effect.Effect<ListRelationsInput, MatrixApiError> {
  return Effect.gen(function* () {
    const authUserId = decodeAuthUserId(input.authUserId);
    const roomId = decodeRoomId(input.roomId);
    if (authUserId instanceof MatrixApiError) {
      return yield* Effect.fail(authUserId);
    }
    if (roomId instanceof MatrixApiError) {
      return yield* Effect.fail(roomId);
    }
    if (!parseEventIdLike(input.eventId)) {
      return yield* Effect.fail(Errors.invalidParam("eventId", "Invalid event ID"));
    }

    return {
      authUserId,
      roomId,
      eventId: input.eventId,
      ...(input.relType ? { relType: input.relType } : {}),
      ...(input.eventType ? { eventType: input.eventType } : {}),
      cursor: parseRelationCursor(input.from),
      limit: decodeLimit(input.limit, 50, 100),
      dir: input.dir === "f" ? "f" : "b",
    };
  });
}

export function decodeListThreadsInput(input: {
  authUserId: string;
  roomId: string;
  limit?: string;
  include?: string;
}): Effect.Effect<ListThreadsInput, MatrixApiError> {
  return Effect.gen(function* () {
    const authUserId = decodeAuthUserId(input.authUserId);
    const roomId = decodeRoomId(input.roomId);
    if (authUserId instanceof MatrixApiError) {
      return yield* Effect.fail(authUserId);
    }
    if (roomId instanceof MatrixApiError) {
      return yield* Effect.fail(roomId);
    }

    return {
      authUserId,
      roomId,
      limit: decodeLimit(input.limit, 50, 100),
      include: input.include === "participated" ? "participated" : "all",
    };
  });
}

export function decodeThreadSubscriptionTargetInput(input: {
  authUserId: string;
  roomId: string;
  threadRootId: string;
}): Effect.Effect<ThreadSubscriptionTargetInput, MatrixApiError> {
  return Effect.gen(function* () {
    const authUserId = decodeAuthUserId(input.authUserId);
    const roomId = decodeRoomId(input.roomId);
    const threadRootId = parseEventIdLike(input.threadRootId);
    if (authUserId instanceof MatrixApiError) {
      return yield* Effect.fail(authUserId);
    }
    if (roomId instanceof MatrixApiError) {
      return yield* Effect.fail(roomId);
    }
    if (!threadRootId) {
      return yield* Effect.fail(Errors.invalidParam("threadRootId", "Invalid thread root ID"));
    }

    return {
      authUserId,
      roomId,
      threadRootId,
    };
  });
}

export function decodePutThreadSubscriptionInput(input: {
  authUserId: string;
  roomId: string;
  threadRootId: string;
  body: unknown;
}): Effect.Effect<PutThreadSubscriptionInput, MatrixApiError> {
  return Effect.gen(function* () {
    const base = yield* decodeThreadSubscriptionTargetInput({
      authUserId: input.authUserId,
      roomId: input.roomId,
      threadRootId: input.threadRootId,
    });

    const requestedAutomaticEventId = isRecord(input.body) ? input.body["automatic"] : undefined;
    if (requestedAutomaticEventId !== undefined && typeof requestedAutomaticEventId !== "string") {
      return yield* Effect.fail(Errors.invalidParam("automatic", "Invalid automatic event ID"));
    }
    if (
      typeof requestedAutomaticEventId === "string" &&
      !parseEventIdLike(requestedAutomaticEventId)
    ) {
      return yield* Effect.fail(Errors.invalidParam("automatic", "Invalid automatic event ID"));
    }

    return {
      ...base,
      ...(typeof requestedAutomaticEventId === "string"
        ? { automaticEventId: requestedAutomaticEventId }
        : {}),
    };
  });
}
