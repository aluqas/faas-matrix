import { ErrorCodes } from "../../../../types";
import type { RoomVersionPolicy } from "../../room-version-policy";
import { DomainError } from "../../domain-error";
import { isValidLocalpart, isValidServerName, parseUserId } from "../../../../utils/ids";

interface OwnedStateAuthorizationInput {
  policy: RoomVersionPolicy;
  eventType: string;
  stateKey?: string;
  senderUserId: string;
  actorPower: number;
  requiredEventPower: number;
}

function isStrictUserId(value: string): boolean {
  const parsed = parseUserId(value as `@${string}:${string}`);
  if (!parsed) {
    return false;
  }

  return isValidLocalpart(parsed.localpart) && isValidServerName(parsed.serverName);
}

function extractLongestStrictUserIdPrefix(
  value: string,
): { userId: string; suffix: string } | null {
  for (let index = value.length; index > 0; index -= 1) {
    const prefix = value.slice(0, index);
    if (isStrictUserId(prefix)) {
      return { userId: prefix, suffix: value.slice(index) };
    }
  }

  return null;
}

function invalidOwnedStateKey(message: string): never {
  throw new DomainError({
    kind: "spec_violation",
    errcode: ErrorCodes.M_BAD_JSON,
    message,
    status: 400,
  });
}

function forbiddenOwnedStateKey(): never {
  throw new DomainError({
    kind: "auth_violation",
    errcode: ErrorCodes.M_FORBIDDEN,
    message: "State keys beginning with '@' are reserved",
    status: 403,
  });
}

export function authorizeOwnedStateEvent(input: OwnedStateAuthorizationInput): void {
  if (input.eventType === "m.room.member") {
    return;
  }

  if (!input.stateKey?.startsWith("@")) {
    return;
  }

  if (!input.policy.ownedStateSupported) {
    if (input.stateKey === input.senderUserId) {
      return;
    }

    forbiddenOwnedStateKey();
  }

  if (input.stateKey === input.senderUserId) {
    return;
  }

  const parsedPrefix = extractLongestStrictUserIdPrefix(input.stateKey);
  const isPrivileged = input.actorPower > input.requiredEventPower;

  if (!parsedPrefix) {
    if (!input.stateKey.includes(":")) {
      invalidOwnedStateKey("State key is not a valid Matrix user ID");
    }

    forbiddenOwnedStateKey();
  }

  if (parsedPrefix.suffix === "") {
    if (parsedPrefix.userId === input.senderUserId || isPrivileged) {
      return;
    }

    forbiddenOwnedStateKey();
  }

  if (parsedPrefix.suffix.startsWith("@")) {
    invalidOwnedStateKey("State key suffix must be separated from the user ID");
  }

  if (parsedPrefix.suffix.startsWith("_")) {
    if (parsedPrefix.userId === input.senderUserId || isPrivileged) {
      return;
    }

    forbiddenOwnedStateKey();
  }

  forbiddenOwnedStateKey();
}
