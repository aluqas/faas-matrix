import { Effect } from "effect";
import type { FederationProfile } from "../../federation-query-service";
import { Errors, MatrixApiError } from "../../../../utils/errors";
import { InfraError } from "../../domain-error";
import {
  dispatchLocalOrRemoteUserQueryEffect,
  resolveLocalOrRemoteUserTarget,
} from "../shared/local-remote-dispatch";
import {
  isSafeFederationServerName,
  type FederationProfileQueryInput,
  type FederationQueryPorts,
} from "./query-shared";

export function queryFederationProfileEffect(
  ports: FederationQueryPorts,
  input: FederationProfileQueryInput,
): Effect.Effect<FederationProfile, MatrixApiError | InfraError> {
  return Effect.gen(function* () {
    const target = resolveLocalOrRemoteUserTarget(input.userId, ports.localServerName);
    if (!target || !isSafeFederationServerName(target.serverName)) {
      return yield* Effect.fail(Errors.invalidParam("user_id", "Invalid user_id"));
    }

    const profile = yield* dispatchLocalOrRemoteUserQueryEffect(target, {
      field: input.field,
      loadLocal: (userId) => ports.profileRepository.getLocalProfile(userId),
      loadRemote: (serverName, userId, field) =>
        ports.profileGateway.fetchRemoteProfile(serverName, userId, field),
    });

    return yield* profile
      ? Effect.succeed(profile)
      : Effect.fail(Errors.notFound("User not found"));
  });
}
