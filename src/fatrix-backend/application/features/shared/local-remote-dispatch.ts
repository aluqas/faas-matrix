import { Effect } from "effect";
import type { UserId } from "../../../../fatrix-model/types/matrix";
import { isLocalServerName, parseUserId } from "../../../../fatrix-model/utils/ids";
import { InfraError } from "../../domain-error";

export interface LocalOrRemoteUserTarget {
  userId: UserId;
  serverName: string;
  isLocal: boolean;
}

export function resolveLocalOrRemoteUserTarget(
  userId: UserId,
  localServerName: string,
): LocalOrRemoteUserTarget | null {
  const parsed = parseUserId(userId);
  if (!parsed) {
    return null;
  }

  return {
    userId,
    serverName: parsed.serverName,
    isLocal: isLocalServerName(parsed.serverName, localServerName),
  };
}

export function dispatchLocalOrRemoteUserQueryEffect<A, TField = never>(
  target: LocalOrRemoteUserTarget,
  input: {
    field?: TField;
    loadLocal: (userId: UserId) => Effect.Effect<A | null, InfraError>;
    loadRemote: (
      serverName: string,
      userId: UserId,
      field?: TField,
    ) => Effect.Effect<A | null, InfraError>;
  },
): Effect.Effect<A | null, InfraError> {
  return target.isLocal
    ? input.loadLocal(target.userId)
    : input.loadRemote(target.serverName, target.userId, input.field);
}
