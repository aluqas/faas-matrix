import { Effect } from "effect";
import type { ThreadSubscriptionState } from "../../../../fatrix-model/types/client";
import type { EventRelationshipsRequest } from "../../../../fatrix-model/types/events";
import type { Membership, PDU, RoomId, UserId } from "../../../../fatrix-model/types";
import { Errors, MatrixApiError } from "../../../../fatrix-model/utils/errors";
import { InfraError } from "../../domain-error";

export interface ClientRelationEvent {
  event_id: string;
  type: string;
  sender: string;
  origin_server_ts: number;
  content: Record<string, unknown>;
  room_id: RoomId;
  unsigned?: Record<string, unknown>;
}

export interface QueryRelationsInput {
  authUserId: UserId;
  request: EventRelationshipsRequest;
}

export interface ListRelationsInput {
  authUserId: UserId;
  roomId: RoomId;
  eventId: string;
  relType?: string;
  eventType?: string;
  cursor?: { value: number; column: "origin_server_ts" | "stream_ordering" } | null;
  limit: number;
  dir: "f" | "b";
}

export interface ListThreadsInput {
  authUserId: UserId;
  roomId: RoomId;
  limit: number;
  include: "all" | "participated";
}

export interface ThreadSubscriptionTargetInput {
  authUserId: UserId;
  roomId: RoomId;
  threadRootId: string;
}

export interface PutThreadSubscriptionInput extends ThreadSubscriptionTargetInput {
  automaticEventId?: string;
}

export interface RelationsMembershipService {
  getMembership(roomId: RoomId, userId: UserId): Effect.Effect<Membership | null, InfraError>;
}

export interface RelationsReaderService {
  queryEventRelationships(
    request: EventRelationshipsRequest,
  ): Effect.Effect<
    { roomId: RoomId; events: PDU[]; limited: boolean; missingParentId?: string } | null,
    InfraError
  >;
  getRemoteServersForRoom(roomId: RoomId): Effect.Effect<string[], InfraError>;
  getRoomVersion(roomId: RoomId): Effect.Effect<string, InfraError>;
  listRelations(
    input: Omit<ListRelationsInput, "authUserId">,
  ): Effect.Effect<{ chunk: ClientRelationEvent[]; nextBatch?: string }, InfraError>;
  listThreads(
    input: Omit<ListThreadsInput, "authUserId"> & { userId: UserId },
  ): Effect.Effect<ClientRelationEvent[], InfraError>;
  threadRootExists(roomId: RoomId, threadRootId: string): Effect.Effect<boolean, InfraError>;
  getThreadSubscriptionContent(
    userId: UserId,
    roomId: RoomId,
  ): Effect.Effect<Record<string, ThreadSubscriptionState>, InfraError>;
  putThreadSubscriptionContent(
    userId: UserId,
    roomId: RoomId,
    content: Record<string, ThreadSubscriptionState>,
  ): Effect.Effect<void, InfraError>;
  getThreadReplyStreamOrdering(
    roomId: RoomId,
    automaticEventId: string,
    threadRootId: string,
  ): Effect.Effect<number | null, InfraError>;
  getLatestThreadStreamOrdering(
    roomId: RoomId,
    threadRootId: string,
  ): Effect.Effect<number, InfraError>;
}

export interface RelationsGatewayService {
  fetchFederatedEventRelationships(
    roomVersion: string,
    remoteServerName: string,
    request: EventRelationshipsRequest,
  ): Effect.Effect<boolean, InfraError>;
}

export interface RelationsQueryPorts {
  localServerName: string;
  membership: RelationsMembershipService;
  relationsReader: RelationsReaderService;
  relationsGateway: RelationsGatewayService;
}

function hasMembership(membership: Membership | null, allowed: readonly Membership[]): boolean {
  return membership !== null && allowed.includes(membership);
}

function customMatrixError(code: string, message: string, status: number): MatrixApiError {
  return new MatrixApiError(
    code as unknown as import("../../../../fatrix-model/types").ErrorCode,
    message,
    status,
  );
}

function requireMembershipEffect(
  membership: Membership | null,
  allowed: readonly Membership[],
  message: string,
): Effect.Effect<void, MatrixApiError> {
  return hasMembership(membership, allowed) ? Effect.void : Effect.fail(Errors.forbidden(message));
}

export function queryEventRelationshipsEffect(
  ports: RelationsQueryPorts,
  input: QueryRelationsInput,
): Effect.Effect<{ events: PDU[]; limited: boolean }, MatrixApiError | InfraError> {
  return Effect.gen(function* () {
    let result = yield* ports.relationsReader.queryEventRelationships(input.request);
    const roomId = result?.roomId ?? input.request.roomId;
    if (!roomId) {
      return yield* Effect.fail(Errors.notFound("Event not found"));
    }

    const membership = yield* ports.membership.getMembership(roomId, input.authUserId);
    yield* requireMembershipEffect(membership, ["join", "leave"], "Not a member of this room");

    const remoteServers = yield* ports.relationsReader.getRemoteServersForRoom(roomId);
    const roomVersion = yield* ports.relationsReader.getRoomVersion(roomId);

    if (input.request.direction === "down" && input.request.roomId && remoteServers.length > 0) {
      yield* ports.relationsGateway.fetchFederatedEventRelationships(
        roomVersion,
        remoteServers[0],
        { ...input.request, roomId },
      );
      result = yield* ports.relationsReader.queryEventRelationships({ ...input.request, roomId });
    } else if (input.request.direction === "up" && remoteServers.length > 0) {
      let missingParentId = result?.missingParentId;
      const attemptedParents = new Set<string>();
      while (missingParentId && !attemptedParents.has(missingParentId)) {
        attemptedParents.add(missingParentId);
        const fetched = yield* ports.relationsGateway.fetchFederatedEventRelationships(
          roomVersion,
          remoteServers[0],
          {
            eventId: missingParentId as EventRelationshipsRequest["eventId"],
            roomId,
            direction: "up",
            maxDepth: input.request.maxDepth,
            recentFirst: input.request.recentFirst,
          },
        );
        if (!fetched) {
          break;
        }
        result = yield* ports.relationsReader.queryEventRelationships({ ...input.request, roomId });
        missingParentId = result?.missingParentId;
      }
    }

    if (!result) {
      return yield* Effect.fail(Errors.notFound("Event not found"));
    }

    return {
      events: result.events,
      limited: result.limited,
    };
  });
}

export function listRelationEventsEffect(
  ports: RelationsQueryPorts,
  input: ListRelationsInput,
): Effect.Effect<
  { chunk: ClientRelationEvent[]; nextBatch?: string },
  MatrixApiError | InfraError
> {
  return Effect.gen(function* () {
    const membership = yield* ports.membership.getMembership(input.roomId, input.authUserId);
    yield* requireMembershipEffect(membership, ["join", "leave"], "Not a member of this room");

    return yield* ports.relationsReader.listRelations({
      roomId: input.roomId,
      eventId: input.eventId,
      relType: input.relType,
      eventType: input.eventType,
      cursor: input.cursor,
      limit: input.limit,
      dir: input.dir,
    });
  });
}

export function listThreadsEffect(
  ports: RelationsQueryPorts,
  input: ListThreadsInput,
): Effect.Effect<{ chunk: ClientRelationEvent[] }, MatrixApiError | InfraError> {
  return Effect.gen(function* () {
    const membership = yield* ports.membership.getMembership(input.roomId, input.authUserId);
    yield* requireMembershipEffect(membership, ["join", "leave"], "Not a member of this room");

    return {
      chunk: yield* ports.relationsReader.listThreads({
        roomId: input.roomId,
        userId: input.authUserId,
        limit: input.limit,
        include: input.include,
      }),
    };
  });
}

export function putThreadSubscriptionEffect(
  ports: RelationsQueryPorts,
  input: PutThreadSubscriptionInput,
): Effect.Effect<void, MatrixApiError | InfraError> {
  return Effect.gen(function* () {
    const membership = yield* ports.membership.getMembership(input.roomId, input.authUserId);
    yield* requireMembershipEffect(membership, ["join"], "Not a member of this room");

    const threadRootExists = yield* ports.relationsReader.threadRootExists(
      input.roomId,
      input.threadRootId,
    );
    if (!threadRootExists) {
      return yield* Effect.fail(Errors.notFound("Thread root not found"));
    }

    const content = yield* ports.relationsReader.getThreadSubscriptionContent(
      input.authUserId,
      input.roomId,
    );

    if (input.automaticEventId) {
      if (input.automaticEventId === input.threadRootId) {
        return yield* Effect.fail(
          customMatrixError(
            "IO.ELEMENT.MSC4306.M_NOT_IN_THREAD",
            "Automatic subscription event must be a thread reply",
            400,
          ),
        );
      }

      const automaticEventStreamOrdering =
        yield* ports.relationsReader.getThreadReplyStreamOrdering(
          input.roomId,
          input.automaticEventId,
          input.threadRootId,
        );
      if (automaticEventStreamOrdering === null) {
        return yield* Effect.fail(
          customMatrixError(
            "IO.ELEMENT.MSC4306.M_NOT_IN_THREAD",
            "Automatic subscription event is not in the requested thread",
            400,
          ),
        );
      }

      const previousSubscription = content[input.threadRootId];
      if (
        previousSubscription?.unsubscribed_after !== undefined &&
        automaticEventStreamOrdering <= previousSubscription.unsubscribed_after
      ) {
        return yield* Effect.fail(
          customMatrixError(
            "IO.ELEMENT.MSC4306.M_CONFLICTING_UNSUBSCRIPTION",
            "Automatic subscription conflicts with a later unsubscription",
            409,
          ),
        );
      }

      content[input.threadRootId] = {
        automatic: true,
        subscribed: true,
        automatic_event_id: input.automaticEventId as ThreadSubscriptionState["automatic_event_id"],
      };
    } else {
      content[input.threadRootId] = {
        automatic: false,
        subscribed: true,
      };
    }

    yield* ports.relationsReader.putThreadSubscriptionContent(
      input.authUserId,
      input.roomId,
      content,
    );
  });
}

export function getThreadSubscriptionEffect(
  ports: RelationsQueryPorts,
  input: ThreadSubscriptionTargetInput,
): Effect.Effect<{ automatic: boolean }, MatrixApiError | InfraError> {
  return Effect.gen(function* () {
    const threadRootExists = yield* ports.relationsReader.threadRootExists(
      input.roomId,
      input.threadRootId,
    );
    if (!threadRootExists) {
      return yield* Effect.fail(Errors.notFound("Thread root not found"));
    }

    const content = yield* ports.relationsReader.getThreadSubscriptionContent(
      input.authUserId,
      input.roomId,
    );
    const subscription = content[input.threadRootId];
    if (!subscription?.subscribed) {
      return yield* Effect.fail(Errors.notFound("Thread subscription not found"));
    }

    return { automatic: subscription.automatic };
  });
}

export function deleteThreadSubscriptionEffect(
  ports: RelationsQueryPorts,
  input: ThreadSubscriptionTargetInput,
): Effect.Effect<void, MatrixApiError | InfraError> {
  return Effect.gen(function* () {
    const content = yield* ports.relationsReader.getThreadSubscriptionContent(
      input.authUserId,
      input.roomId,
    );
    const existingSubscription = content[input.threadRootId];
    if (!existingSubscription?.subscribed) {
      return;
    }

    const latestThreadStreamOrdering = yield* ports.relationsReader.getLatestThreadStreamOrdering(
      input.roomId,
      input.threadRootId,
    );

    content[input.threadRootId] = {
      automatic: false,
      subscribed: false,
      unsubscribed_after: latestThreadStreamOrdering,
    };

    yield* ports.relationsReader.putThreadSubscriptionContent(
      input.authUserId,
      input.roomId,
      content,
    );
  });
}
