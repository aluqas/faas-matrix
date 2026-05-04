import type { Membership } from "../../../../../fatrix-model/types";
import type { Env } from "../../../env";
import {
  fromInfraNullable,
  fromInfraPromise,
  fromInfraVoid,
} from "../../../../../fatrix-backend/application/effect/infra-effect";
import {
  getLatestThreadStreamOrdering,
  getRemoteServersForRelationRoom,
  getRoomMembershipForRelations,
  getRoomVersionForRelations,
  getThreadReplyStreamOrdering,
  getThreadSubscriptionContent,
  listRelationEvents,
  listThreadRoots,
  putThreadSubscriptionContent,
  queryRelationEventTree,
  threadRootExists,
} from "../../repositories/relations-repository";
import type { RelationsQueryPorts } from "../../../../../fatrix-backend/application/features/relations/query";
import { fetchFederatedEventRelationshipsResponse } from "./gateway";

export function createRelationsQueryPorts(
  env: Pick<Env, "DB" | "CACHE" | "SERVER_NAME">,
): RelationsQueryPorts {
  return {
    localServerName: env.SERVER_NAME,
    membership: {
      getMembership: (roomId, userId) =>
        fromInfraNullable<Membership | null>(
          async () =>
            (await getRoomMembershipForRelations(env.DB, roomId, userId)) as Membership | null,
          "Failed to load room membership",
        ),
    },
    relationsReader: {
      queryEventRelationships: (request) =>
        fromInfraNullable(async () => {
          const result = await queryRelationEventTree(env.DB, request);
          return result
            ? {
                ...result,
                roomId: result.roomId as import("../../../../../fatrix-model/types").RoomId,
              }
            : null;
        }, "Failed to query event relationships"),
      getRemoteServersForRoom: (roomId) =>
        fromInfraPromise(
          () => getRemoteServersForRelationRoom(env.DB, roomId, env.SERVER_NAME),
          "Failed to load remote servers for room",
        ),
      getRoomVersion: (roomId) =>
        fromInfraPromise(
          () => getRoomVersionForRelations(env.DB, roomId),
          "Failed to load room version",
        ),
      listRelations: (input) =>
        fromInfraPromise(async () => {
          const result = await listRelationEvents(env.DB, input);
          return {
            ...result,
            chunk:
              result.chunk as import("../../../../../fatrix-backend/application/features/relations/query").ClientRelationEvent[],
          };
        }, "Failed to list relation events"),
      listThreads: (input) =>
        fromInfraPromise(
          async () =>
            (await listThreadRoots(
              env.DB,
              input,
            )) as import("../../../../../fatrix-backend/application/features/relations/query").ClientRelationEvent[],
          "Failed to list thread roots",
        ),
      threadRootExists: (roomId, threadRootId) =>
        fromInfraPromise(
          () => threadRootExists(env.DB, roomId, threadRootId),
          "Failed to load thread root",
        ),
      getThreadSubscriptionContent: (userId, roomId) =>
        fromInfraPromise(
          () => getThreadSubscriptionContent(env.DB, userId, roomId),
          "Failed to load thread subscription content",
        ),
      putThreadSubscriptionContent: (userId, roomId, content) =>
        fromInfraVoid(
          () => putThreadSubscriptionContent(env.DB, userId, roomId, content),
          "Failed to store thread subscription content",
        ),
      getThreadReplyStreamOrdering: (roomId, automaticEventId, threadRootId) =>
        fromInfraNullable(
          () => getThreadReplyStreamOrdering(env.DB, roomId, automaticEventId, threadRootId),
          "Failed to load thread reply",
        ),
      getLatestThreadStreamOrdering: (roomId, threadRootId) =>
        fromInfraPromise(
          () => getLatestThreadStreamOrdering(env.DB, roomId, threadRootId),
          "Failed to load latest thread stream ordering",
        ),
    },
    relationsGateway: {
      fetchFederatedEventRelationships: (roomVersion, remoteServerName, request) =>
        fromInfraPromise(
          () =>
            fetchFederatedEventRelationshipsResponse(env, remoteServerName, roomVersion, request),
          "Failed to fetch federated event relationships",
        ),
    },
  };
}
