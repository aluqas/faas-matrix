import { Effect } from "effect";
import { Errors, MatrixApiError } from "../../../../utils/errors";
import { InfraError } from "../../domain-error";
import type { EventRelationshipsRequest } from "../../relationship-service";
import type { FederationQueryPorts, FederationRelationshipsResult } from "./query-shared";

export function queryFederationEventRelationshipsEffect(
  ports: FederationQueryPorts,
  request: EventRelationshipsRequest,
): Effect.Effect<FederationRelationshipsResult, MatrixApiError | InfraError> {
  return Effect.flatMap(ports.relationshipsReader.buildEventRelationships(request), (result) =>
    result ? Effect.succeed(result) : Effect.fail(Errors.notFound("Event not found")),
  );
}
