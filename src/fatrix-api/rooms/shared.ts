import type { Context } from "hono";
import type { RoomId } from "../../fatrix-model/types";
import type { AppEnv } from "../hono-env";
import { isJsonObject } from "../../fatrix-model/types/common";
import { ErrorCodes } from "../../fatrix-model/types";
import { Errors, MatrixApiError } from "../../fatrix-model/utils/errors";
import { parseRoomAlias, toRoomId, toUserId } from "../../fatrix-model/utils/ids";
import { federationGet } from "../../platform/cloudflare/adapters/federation/federation-keys";
import { getMembership, getRoomByAlias, getStateEvent } from "../../platform/cloudflare/adapters/db/database";

export function toRouteErrorResponse(error: unknown): Response | null {
  if (error instanceof SyntaxError) {
    return Errors.badJson().toResponse();
  }

  if (error instanceof Error && "toResponse" in error) {
    return (error as { toResponse(): Response }).toResponse();
  }

  return null;
}

export const MAX_ROOM_EVENT_CONTENT_BYTES = 64 * 1024;

function assertFiniteJsonNumbers(value: unknown): void {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw Errors.badJson("JSON numbers must be finite");
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      assertFiniteJsonNumbers(entry);
    }
    return;
  }

  if (value && typeof value === "object") {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      assertFiniteJsonNumbers(entry);
    }
  }
}

function parseStrictJsonBody(bodyText: string): unknown {
  const parsed = JSON.parse(bodyText) as unknown;
  assertFiniteJsonNumbers(parsed);
  return parsed;
}

export async function parseOptionalJsonObjectBody(
  c: Context<AppEnv>,
  options: {
    maxBytes?: number;
  } = {},
): Promise<Record<string, unknown> | undefined> {
  const bodyText = await c.req.text();
  if (bodyText.trim().length === 0) {
    return undefined;
  }

  if (options.maxBytes !== undefined) {
    const size = new TextEncoder().encode(bodyText).length;
    if (size > options.maxBytes) {
      throw Errors.tooLarge("Event content exceeds the maximum allowed size");
    }
  }

  const parsed = parseStrictJsonBody(bodyText);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw Errors.badJson();
  }

  return parsed as Record<string, unknown>;
}

export async function parseRequiredJsonObjectBody(
  c: Context<AppEnv>,
  options: {
    maxBytes?: number;
  } = {},
): Promise<Record<string, unknown>> {
  const parsed = await parseOptionalJsonObjectBody(c, options);
  if (!parsed) {
    throw Errors.badJson();
  }
  return parsed;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function resolveRoomIdOrAlias(
  c: Context<AppEnv>,
  roomIdOrAlias: string,
  serverHints: string[],
): Promise<{ roomId: RoomId; remoteServers: string[] }> {
  if (!roomIdOrAlias.startsWith("#")) {
    const roomId = toRoomId(roomIdOrAlias);
    if (!roomId) {
      throw Errors.invalidParam("room_id", "Invalid room ID");
    }
    return { roomId, remoteServers: serverHints };
  }

  const localRoomId = await getRoomByAlias(c.env.DB, roomIdOrAlias);
  if (localRoomId) {
    const roomId = toRoomId(localRoomId);
    if (!roomId) {
      throw Errors.notFound("Room alias not found");
    }
    return { roomId, remoteServers: serverHints };
  }

  const parsedAlias = parseRoomAlias(roomIdOrAlias);
  if (!parsedAlias) {
    throw Errors.notFound("Room alias not found");
  }

  const candidateServers = Array.from(new Set([parsedAlias.serverName, ...serverHints]));
  for (const serverName of candidateServers) {
    const response = await federationGet(
      serverName,
      `/_matrix/federation/v1/query/directory?room_alias=${encodeURIComponent(roomIdOrAlias)}`,
      c.env.SERVER_NAME,
      c.env.DB,
      c.env.CACHE,
    ).catch(() => null);

    if (!response?.ok) {
      continue;
    }

    const body = await response.json();
    if (!isJsonObject(body)) {
      continue;
    }
    if (typeof body.room_id !== "string") {
      continue;
    }
    const roomId = toRoomId(body.room_id);
    if (!roomId) {
      continue;
    }

    const responseServers = Array.isArray(body.servers)
      ? body.servers.filter((value): value is string => typeof value === "string")
      : [];

    return {
      roomId,
      remoteServers: Array.from(new Set([...candidateServers, ...responseServers])),
    };
  }

  throw Errors.notFound("Room alias not found");
}

function badAlias(message: string = "Room alias does not point to this room"): MatrixApiError {
  return new MatrixApiError(ErrorCodes.M_BAD_ALIAS, message, 400);
}

async function validateCanonicalAliasReference(
  db: D1Database,
  roomId: string,
  alias: string,
): Promise<MatrixApiError | null> {
  if (!parseRoomAlias(alias)) {
    return Errors.invalidParam("alias", "Invalid room alias format");
  }

  const mappedRoomId = await getRoomByAlias(db, alias);
  if (!mappedRoomId || mappedRoomId !== roomId) {
    return badAlias();
  }

  return null;
}

export async function validateCanonicalAliasContent(
  db: D1Database,
  roomId: string,
  content: unknown,
): Promise<MatrixApiError | null> {
  if (!isRecord(content)) {
    return Errors.badJson();
  }

  const alias = content["alias"];
  if (alias !== undefined) {
    if (typeof alias !== "string") {
      return Errors.invalidParam("alias", "alias must be a string");
    }
    const aliasError = await validateCanonicalAliasReference(db, roomId, alias);
    if (aliasError) {
      return aliasError;
    }
  }

  const altAliases = content["alt_aliases"];
  if (altAliases !== undefined) {
    if (!Array.isArray(altAliases) || altAliases.some((entry) => typeof entry !== "string")) {
      return Errors.invalidParam("alt_aliases", "alt_aliases must be an array of room aliases");
    }

    for (const altAlias of altAliases) {
      const aliasError = await validateCanonicalAliasReference(db, roomId, altAlias);
      if (aliasError) {
        return aliasError;
      }
    }
  }

  return null;
}

export function getUserPowerLevelFromContent(
  content: unknown,
  userId: string,
): { userPower: number; stateDefault: number; eventLevels: Record<string, number> } {
  if (!isRecord(content)) {
    return { userPower: 0, stateDefault: 50, eventLevels: {} };
  }

  const users = isRecord(content["users"]) ? content["users"] : {};
  const events = isRecord(content["events"]) ? content["events"] : {};
  const usersDefault = typeof content["users_default"] === "number" ? content["users_default"] : 0;
  const stateDefault = typeof content["state_default"] === "number" ? content["state_default"] : 50;
  const explicitUserPower = users[userId];
  const userPower = typeof explicitUserPower === "number" ? explicitUserPower : usersDefault;

  return {
    userPower,
    stateDefault,
    eventLevels: Object.fromEntries(
      Object.entries(events).filter(([, value]) => typeof value === "number"),
    ) as Record<string, number>,
  };
}

export async function canUserSendStateEvent(
  db: D1Database,
  roomId: string,
  userId: string,
  eventType: string,
): Promise<boolean> {
  const membership = await getMembership(db, toRoomId(roomId), toUserId(userId));
  if (!membership || membership.membership !== "join") {
    return false;
  }

  const powerLevelsEvent = await getStateEvent(db, toRoomId(roomId), "m.room.power_levels", "");
  const { userPower, stateDefault, eventLevels } = getUserPowerLevelFromContent(
    powerLevelsEvent?.content,
    userId,
  );
  const requiredPower =
    typeof eventLevels[eventType] === "number" ? eventLevels[eventType] : stateDefault;

  return userPower >= requiredPower;
}

export function removeDeletedAliasFromCanonicalContent(
  content: unknown,
  deletedAlias: string,
): Record<string, unknown> | null {
  if (!isRecord(content)) {
    return null;
  }

  const nextContent: Record<string, unknown> = { ...content };
  let changed = false;

  if (nextContent["alias"] === deletedAlias) {
    delete nextContent["alias"];
    changed = true;
  }

  const altAliases = nextContent["alt_aliases"];
  if (Array.isArray(altAliases)) {
    const remaining = altAliases.filter((entry): entry is string => typeof entry === "string");
    const filtered = remaining.filter((entry) => entry !== deletedAlias);
    if (filtered.length !== remaining.length) {
      changed = true;
      if (filtered.length > 0) {
        nextContent["alt_aliases"] = filtered;
      } else {
        delete nextContent["alt_aliases"];
      }
    }
  }

  return changed ? nextContent : null;
}
