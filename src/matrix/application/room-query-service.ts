import { Effect } from "effect";
import type { AppContext } from "../../foundation/app-context";
import { ErrorCodes, type Membership, type PDU, type UnsignedData } from "../../types";
import {
  getMembership,
  getRoomEvents,
  getRoomMembers,
  getRoomState,
  getStateEvent,
} from "../../services/database";
import { EventQueryService, type TimestampDirection } from "./event-query-service";
import { DomainError, InfraError } from "./domain-error";
import {
  getPartialStateCompletionStatus,
  getPartialStateStatus,
  type PartialStateStatus,
} from "./features/partial-state/tracker";

type MembershipRecord = {
  membership: Membership;
  eventId: string;
};

type RoomMemberRecord = {
  userId: string;
  membership: Membership;
  displayName?: string;
  avatarUrl?: string;
};

export type ClientRoomEvent = {
  type: string;
  state_key?: string;
  content: Record<string, unknown>;
  sender: string;
  origin_server_ts: number;
  event_id: string;
  room_id: string;
  unsigned?: UnsignedData;
};

export interface RoomMessagesRelationFilter {
  relTypes?: string[];
  notRelTypes?: string[];
}

export interface GetRoomStateInput {
  userId: string;
  roomId: string;
}

export interface GetRoomStateEventInput {
  userId: string;
  roomId: string;
  eventType: string;
  stateKey: string;
  formatEvent?: boolean;
}

export interface GetRoomMembersInput {
  userId: string;
  roomId: string;
}

export interface GetRoomMessagesInput {
  userId: string;
  roomId: string;
  from?: string;
  dir: "f" | "b";
  limit: number;
  relationFilter?: RoomMessagesRelationFilter;
}

export interface GetVisibleRoomEventInput {
  userId: string;
  roomId: string;
  eventId: string;
}

export interface TimestampToEventInput {
  userId: string;
  roomId: string;
  ts: number;
  dir: TimestampDirection;
}

export interface RoomQueryDependencies {
  getMembership(db: D1Database, roomId: string, userId: string): Promise<MembershipRecord | null>;
  getRoomState(db: D1Database, roomId: string): Promise<PDU[]>;
  getStateEvent(
    db: D1Database,
    roomId: string,
    eventType: string,
    stateKey: string,
  ): Promise<PDU | null>;
  getRoomMembers(db: D1Database, roomId: string): Promise<RoomMemberRecord[]>;
  getRoomEvents(
    db: D1Database,
    roomId: string,
    fromToken: number | undefined,
    limit: number,
    direction: "f" | "b",
    relationFilter?: RoomMessagesRelationFilter,
  ): Promise<{ events: PDU[]; end: number }>;
  getVisibleEventForUser(
    db: D1Database,
    roomId: string,
    eventId: string,
    userId: string,
  ): Promise<PDU | null>;
  findClosestEventByTimestamp(
    db: D1Database,
    roomId: string,
    ts: number,
    dir: TimestampDirection,
  ): Promise<{ event_id: string; origin_server_ts: number } | null>;
  getPartialStateJoin(
    cache: KVNamespace | undefined,
    userId: string,
    roomId: string,
  ): Promise<PartialStateStatus | null>;
  getPartialStateJoinCompletion(
    cache: KVNamespace | undefined,
    userId: string,
    roomId: string,
  ): Promise<PartialStateStatus | null>;
  sleep(ms: number): Promise<void>;
}

const eventQueries = new EventQueryService();

const defaultDependencies: RoomQueryDependencies = {
  getMembership,
  getRoomState,
  getStateEvent,
  getRoomMembers,
  getRoomEvents,
  getVisibleEventForUser: (db, roomId, eventId, userId) =>
    eventQueries.getVisibleEventForUser(db, roomId, eventId, userId),
  findClosestEventByTimestamp: (db, roomId, ts, dir) =>
    eventQueries.findClosestEventByTimestamp(db, roomId, ts, dir),
  getPartialStateJoin: getPartialStateStatus,
  getPartialStateJoinCompletion: getPartialStateCompletionStatus,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

function toInfraError(message: string, cause: unknown, status = 500): InfraError {
  return new InfraError({
    errcode: ErrorCodes.M_UNKNOWN,
    message,
    status,
    cause,
  });
}

function forbiddenDomainError(message: string): DomainError {
  return new DomainError({
    kind: "auth_violation",
    errcode: ErrorCodes.M_FORBIDDEN,
    message,
    status: 403,
  });
}

function notFoundDomainError(message: string): DomainError {
  return new DomainError({
    kind: "state_invariant",
    errcode: ErrorCodes.M_NOT_FOUND,
    message,
    status: 404,
  });
}

function toClientRoomEvent(event: PDU): ClientRoomEvent {
  return {
    type: event.type,
    state_key: event.state_key,
    content: event.content,
    sender: event.sender,
    origin_server_ts: event.origin_server_ts,
    event_id: event.event_id,
    room_id: event.room_id,
    ...(event.unsigned !== undefined ? { unsigned: event.unsigned } : {}),
  };
}

function parseFromToken(from: string | undefined): number | undefined {
  if (!from) {
    return undefined;
  }

  const tokenStr = from.startsWith("s") ? from.slice(1) : from;
  const parsed = Number.parseInt(tokenStr, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

export class MatrixRoomQueryService {
  constructor(
    private readonly appContext: AppContext,
    private readonly dependencies: RoomQueryDependencies = defaultDependencies,
  ) {}

  private getDb(): D1Database {
    return this.appContext.capabilities.sql.connection as D1Database;
  }

  private getCache(): KVNamespace | undefined {
    return this.appContext.capabilities.kv.cache as KVNamespace | undefined;
  }

  private fromPromise<A>(
    message: string,
    operation: () => Promise<A>,
  ): Effect.Effect<A, InfraError> {
    return Effect.tryPromise({
      try: operation,
      catch: (cause) => toInfraError(message, cause),
    });
  }

  private membershipEffect(roomId: string, userId: string) {
    const db = this.getDb();
    return this.fromPromise("Failed to load room membership", () =>
      this.dependencies.getMembership(db, roomId, userId),
    );
  }

  private requireMembershipEffect(
    roomId: string,
    userId: string,
    allowedMemberships: readonly Membership[],
    message = "Not a member of this room",
  ): Effect.Effect<MembershipRecord, DomainError | InfraError> {
    return this.membershipEffect(roomId, userId).pipe(
      Effect.flatMap((membership) => {
        if (membership && allowedMemberships.includes(membership.membership)) {
          return Effect.succeed(membership);
        }

        return Effect.fail(forbiddenDomainError(message));
      }),
    );
  }

  private waitForPartialStateJoinCompletionEffect(
    userId: string,
    roomId: string,
    timeoutMs = 2000,
  ): Effect.Effect<void, InfraError> {
    const cache = this.getCache();
    const now = this.appContext.capabilities.clock.now.bind(this.appContext.capabilities.clock);
    const deadline = now() + timeoutMs;
    const getMarker = () =>
      this.fromPromise("Failed to load partial-state status", () =>
        this.dependencies.getPartialStateJoin(cache, userId, roomId),
      );
    const getCompletion = () =>
      this.fromPromise("Failed to load partial-state completion status", () =>
        this.dependencies.getPartialStateJoinCompletion(cache, userId, roomId),
      );
    const sleep = (ms: number) =>
      this.fromPromise("Failed while waiting for partial-state completion", () =>
        this.dependencies.sleep(ms),
      );

    return Effect.gen(function* () {
      while (now() < deadline) {
        const [marker, completion] = yield* Effect.all([getMarker(), getCompletion()], {
          concurrency: 2,
        });
        if (!marker || marker.phase === "complete") {
          return;
        }

        yield* sleep(completion ? 25 : 100);
      }
    });
  }

  getCurrentState(
    input: GetRoomStateInput,
  ): Effect.Effect<ClientRoomEvent[], DomainError | InfraError> {
    const db = this.getDb();
    const loadRoomState = this.fromPromise.bind(this);
    const requireMembership = this.requireMembershipEffect.bind(this);
    const dependencies = this.dependencies;

    return Effect.gen(function* () {
      yield* requireMembership(input.roomId, input.userId, ["join", "leave"]);
      const state = yield* loadRoomState("Failed to load room state", () =>
        dependencies.getRoomState(db, input.roomId),
      );
      return state.map(toClientRoomEvent);
    });
  }

  getStateEvent(
    input: GetRoomStateEventInput,
  ): Effect.Effect<Record<string, unknown> | ClientRoomEvent, DomainError | InfraError> {
    const db = this.getDb();
    const requireMembership = this.requireMembershipEffect.bind(this);
    const loadStateEvent = this.fromPromise.bind(this);
    const dependencies = this.dependencies;

    return Effect.gen(function* () {
      yield* requireMembership(input.roomId, input.userId, ["join"]);
      const event = yield* loadStateEvent("Failed to load room state event", () =>
        dependencies.getStateEvent(db, input.roomId, input.eventType, input.stateKey),
      );

      if (!event) {
        return yield* Effect.fail(notFoundDomainError("State event not found"));
      }

      return input.formatEvent ? toClientRoomEvent(event) : event.content;
    });
  }

  getMembers(
    input: GetRoomMembersInput,
  ): Effect.Effect<{ chunk: ClientRoomEvent[] }, DomainError | InfraError> {
    const db = this.getDb();
    const waitForPartialState = this.waitForPartialStateJoinCompletionEffect.bind(this);
    const requireMembership = this.requireMembershipEffect.bind(this);
    const loadMembers = this.fromPromise.bind(this);
    const dependencies = this.dependencies;

    return Effect.gen(function* () {
      yield* waitForPartialState(input.userId, input.roomId);
      yield* requireMembership(input.roomId, input.userId, ["join", "leave"]);

      const members = yield* loadMembers("Failed to load room members", () =>
        dependencies.getRoomMembers(db, input.roomId),
      );
      const events = yield* Effect.all(
        members.map((member) =>
          loadMembers("Failed to load room member state event", () =>
            dependencies.getStateEvent(db, input.roomId, "m.room.member", member.userId),
          ),
        ),
        { concurrency: "unbounded" },
      );

      return {
        chunk: events
          .filter((event): event is PDU => event !== null && event !== undefined)
          .map(toClientRoomEvent),
      };
    });
  }

  getMessages(
    input: GetRoomMessagesInput,
  ): Effect.Effect<
    { start: string; end?: string; chunk: ClientRoomEvent[] },
    DomainError | InfraError
  > {
    const db = this.getDb();
    const requireMembership = this.requireMembershipEffect.bind(this);
    const loadRoomEvents = this.fromPromise.bind(this);
    const dependencies = this.dependencies;

    return Effect.gen(function* () {
      yield* requireMembership(input.roomId, input.userId, ["join"]);

      const fromToken = parseFromToken(input.from);
      const { events, end } = yield* loadRoomEvents("Failed to load room messages", () =>
        dependencies.getRoomEvents(
          db,
          input.roomId,
          fromToken,
          input.limit,
          input.dir,
          input.relationFilter,
        ),
      );

      return {
        start: input.from ?? "s0",
        ...(events.length > 0 ? { end: `s${end}` } : {}),
        chunk: events.map(toClientRoomEvent),
      };
    });
  }

  getVisibleEvent(
    input: GetVisibleRoomEventInput,
  ): Effect.Effect<ClientRoomEvent, DomainError | InfraError> {
    const db = this.getDb();
    const loadVisibleEvent = this.fromPromise.bind(this);
    const dependencies = this.dependencies;

    return Effect.gen(function* () {
      const event = yield* loadVisibleEvent("Failed to load visible room event", () =>
        dependencies.getVisibleEventForUser(db, input.roomId, input.eventId, input.userId),
      );

      if (!event) {
        return yield* Effect.fail(notFoundDomainError("Event not found"));
      }

      return toClientRoomEvent(event);
    });
  }

  getTimestampToEvent(
    input: TimestampToEventInput,
  ): Effect.Effect<{ event_id: string; origin_server_ts: number }, DomainError | InfraError> {
    const db = this.getDb();
    const requireMembership = this.requireMembershipEffect.bind(this);
    const loadClosestEvent = this.fromPromise.bind(this);
    const dependencies = this.dependencies;

    return Effect.gen(function* () {
      yield* requireMembership(input.roomId, input.userId, ["join"]);
      const event = yield* loadClosestEvent("Failed to find event by timestamp", () =>
        dependencies.findClosestEventByTimestamp(db, input.roomId, input.ts, input.dir),
      );

      if (!event) {
        return yield* Effect.fail(notFoundDomainError("No event found for the given timestamp"));
      }

      return event;
    });
  }
}
