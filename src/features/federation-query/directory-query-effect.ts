import { Effect } from "effect";
import { Errors, MatrixApiError } from "../../shared/utils/errors";
import { InfraError } from "../../matrix/application/domain-error";
import type { FederationDirectoryQueryInput, FederationQueryPorts } from "./query-shared";

export function resolveFederationDirectoryEffect(
  ports: FederationQueryPorts,
  input: FederationDirectoryQueryInput,
): Effect.Effect<{ room_id: string; servers: string[] }, MatrixApiError | InfraError> {
  return Effect.flatMap(
    ports.roomDirectoryRepository.findRoomIdByAlias(input.roomAlias),
    (roomId) =>
      roomId
        ? Effect.succeed({ room_id: roomId, servers: [ports.localServerName] })
        : Effect.fail(Errors.notFound("Room alias not found")),
  );
}
