import type { Context } from "hono";
import type { AppEnv } from "../../types";
import { ErrorCodes } from "../../types";
import { Errors, MatrixApiError } from "../../utils/errors";
import { parseRoomAlias } from "../../utils/ids";
import { federationGet } from "../../services/federation-keys";
import { getMembership, getRoomByAlias, getStateEvent } from "../../services/database";

export function toRouteErrorResponse(error: unknown): Response | null {
  if (error instanceof SyntaxError) {
    return Errors.badJson().toResponse();
  }

  if (error instanceof Error && "toResponse" in error) {
    return (error as { toResponse(): Response }).toResponse();
  }

  return null;
}

export async function parseOptionalJsonObjectBody(
  c: Context<AppEnv>,
): Promise<Record<string, unknown> | undefined> {
  const bodyText = await c.req.text();
  if (bodyText.trim().length === 0) {
    return undefined;
  }

  const parsed = JSON.parse(bodyText) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw Errors.badJson();
  }

  return parsed as Record<string, unknown>;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function resolveRoomIdOrAlias(
  c: Context<AppEnv>,
  roomIdOrAlias: string,
  serverHints: string[],
): Promise<{ roomId: string; remoteServers: string[] }> {
  if (!roomIdOrAlias.startsWith("#")) {
    return { roomId: roomIdOrAlias, remoteServers: serverHints };
  }

  const localRoomId = await getRoomByAlias(c.env.DB, roomIdOrAlias);
  if (localRoomId) {
    return { roomId: localRoomId, remoteServers: serverHints };
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

    const body = (await response.json()) as { room_id?: unknown; servers?: unknown };
    if (typeof body.room_id !== "string") {
      continue;
    }

    const responseServers = Array.isArray(body.servers)
      ? body.servers.filter((value): value is string => typeof value === "string")
      : [];

    return {
      roomId: body.room_id,
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
  const membership = await getMembership(db, roomId, userId);
  if (!membership || membership.membership !== "join") {
    return false;
  }

  const powerLevelsEvent = await getStateEvent(db, roomId, "m.room.power_levels", "");
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
