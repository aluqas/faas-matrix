/**
 * Room-version-specific semantic rules that must be enforced consistently
 * across client, federation, and workflow paths.
 *
 * Centralizes decisions that were previously scattered across route handlers
 * and event-auth, so each rule is encoded once and reused.
 */
import { Effect } from "effect";
import { ErrorCodes } from "../../../../../fatrix-model/types";
import { DomainError } from "../../../domain-error";
import { canonicalJson, sha256 } from "../../../../../fatrix-model/utils/crypto";

function forbidden(message: string): DomainError {
  return new DomainError({
    kind: "auth_violation",
    errcode: ErrorCodes.M_FORBIDDEN,
    message,
    status: 403,
  });
}

/**
 * Returns true for room versions where the room ID is derived from the
 * SHA-256 hash of the create event content (MSC4291 / v12+).
 */
export function usesHashBasedRoomId(roomVersion: string): boolean {
  const versionNum = Number.parseInt(roomVersion, 10);
  return !Number.isNaN(versionNum) && versionNum >= 12;
}

/**
 * Asserts that a client PUT/send cannot replace m.room.create.
 * The create event is the foundation of a room and is immutable once set.
 * Returns Effect.void when the event type is not m.room.create.
 */
export function assertCreateEventNotReplaceable(
  eventType: string,
): Effect.Effect<void, DomainError> {
  if (eventType !== "m.room.create") {
    return Effect.void;
  }
  return Effect.fail(forbidden("The m.room.create event cannot be replaced"));
}

/**
 * Derives the room ID for v12 rooms from the create event content.
 *
 * Algorithm per MSC4291:
 *   room_id = "!" + base64url_unpadded(sha256(canonical_json(content))) + ":" + server_name
 *
 * The content passed here must be the create event content WITHOUT the room_id field.
 */
export async function deriveV12RoomId(
  createEventContent: Record<string, unknown>,
  serverName: string,
): Promise<string> {
  const canonical = canonicalJson(createEventContent);
  const hash = await sha256(canonical);
  return `!${hash}:${serverName}`;
}

/**
 * Returns true for room versions where the full create event must be included
 * in stripped state bundles (MSC4311 / v12+).
 */
export function requiresFullCreateEventInStrippedState(roomVersion: string): boolean {
  const versionNum = Number.parseInt(roomVersion, 10);
  return !Number.isNaN(versionNum) && versionNum >= 12;
}
