import type { Effect } from "effect";
import {
  withIdempotency,
  type IdempotencyStore,
} from "../../../../../fetherate/runtime/idempotency";
import type { AppContext } from "../../../../ports/runtime/app-context";
import type { EventPipeline } from "../../../domain/event-pipeline";
import { DomainError, toMatrixApiError } from "../../../domain-error";
import { emitEffectWarning } from "../../../runtime/effect-debug";
import { runClientEffect } from "../../../runtime/effect-runtime";
import type { RoomRepository } from "../../../../ports/repositories";
import type { PDU } from "../../../../../fatrix-model/types";
import type { SendEventInput } from "../../../../../fatrix-model/types/rooms";
import { Errors, MatrixApiError } from "../../../../../fatrix-model/utils/errors";
import { assertCreateEventNotReplaceable } from "../policies/room-version-semantics";
import {
  assertOwnedStateEventAllowed,
  assertRedactionAllowed,
  buildRoomEvent,
  hasEquivalentStateEvent,
} from "./send-event-builder";

type TransactionResponse = Record<string, unknown>;
type RoomCommandLogger = {
  info: (
    event: `${string}.${string}.${string}`,
    fields?: Record<string, unknown>,
  ) => Effect.Effect<void>;
  error: (
    event: `${string}.${string}.${string}`,
    error: unknown,
    fields?: Record<string, unknown>,
  ) => Effect.Effect<void>;
};

export interface SendRoomEventCommandPorts {
  appContext: AppContext;
  repository: RoomRepository;
  eventPipeline: EventPipeline;
  idempotencyStore: IdempotencyStore<TransactionResponse>;
  logger: RoomCommandLogger;
  deferRoomAsyncTask(
    logger: RoomCommandLogger,
    fields: Record<string, unknown>,
    task: () => Promise<void>,
  ): void;
  attachFederationMetadata(event: PDU, roomVersion?: string): Promise<PDU>;
  fanoutEventToFederation(roomId: string, event: PDU): Promise<void>;
}

function withOptionalValue<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  if (value === undefined) {
    return {};
  }

  return { [key]: value } as { [P in K]?: V };
}

export async function sendRoomEventCommand(
  ports: SendRoomEventCommandPorts,
  input: SendEventInput,
): Promise<{ event_id: string }> {
  const logger = ports.logger;
  await runClientEffect(
    logger.info("room.command.start", {
      command: "send_event",
      event_type: input.eventType,
      state_key: input.stateKey,
      txn_id: input.txnId,
    }),
  );
  try {
    const response = await withIdempotency(
      ports.idempotencyStore,
      input.userId,
      input.txnId,
      async () => {
        if (input.stateKey !== undefined) {
          const existingStateEvent = await ports.repository.getStateEvent(
            input.roomId,
            input.eventType,
            input.stateKey,
          );
          if (hasEquivalentStateEvent(existingStateEvent, input.userId, input.content)) {
            await runClientEffect(
              logger.info("room.command.success", {
                command: "send_event",
                room_id: input.roomId,
                event_type: input.eventType,
                state_key: input.stateKey,
                event_id: existingStateEvent.event_id,
                idempotent: true,
              }),
            );
            return { event_id: existingStateEvent.event_id };
          }
        }

        const result = await ports.eventPipeline.execute({
          input,
          validate: () => {
            if (!input.eventType) {
              throw Errors.missingParam("eventType");
            }
          },
          resolveAuth: async () => {
            const room = await ports.repository.getRoom(input.roomId);
            if (!room) {
              throw Errors.notFound("Room not found");
            }
            return {
              userId: input.userId,
              roomVersion: room.room_version,
            };
          },
          authorize: async (_pipelineInput, auth) => {
            await runClientEffect(assertCreateEventNotReplaceable(input.eventType));

            const membership = await ports.repository.getMembership(input.roomId, auth.userId);
            if (!membership || membership.membership !== "join") {
              throw Errors.forbidden("Not a member of this room");
            }

            if (input.eventType === "m.room.redaction" && input.redacts) {
              const powerLevelsEvent = await ports.repository.getStateEvent(
                input.roomId,
                "m.room.power_levels",
              );
              const targetEvent = await ports.repository.getEvent(input.redacts);
              assertRedactionAllowed({
                powerLevelsEvent,
                targetEvent,
                roomId: input.roomId,
                userId: auth.userId,
              });
            }

            if (input.stateKey?.startsWith("@")) {
              const powerLevelsEvent = await ports.repository.getStateEvent(
                input.roomId,
                "m.room.power_levels",
              );
              assertOwnedStateEventAllowed({
                roomVersion: auth.roomVersion,
                powerLevelsEvent,
                eventType: input.eventType,
                stateKey: input.stateKey,
                senderUserId: auth.userId,
              });
            }
          },
          buildEvent: async (_pipelineInput, auth) => {
            const membership = await ports.repository.getMembership(input.roomId, auth.userId);
            const createEvent = await ports.repository.getStateEvent(input.roomId, "m.room.create");
            const powerLevelsEvent = await ports.repository.getStateEvent(
              input.roomId,
              "m.room.power_levels",
            );
            const latestEvents = await ports.repository.getLatestRoomEvents(input.roomId, 1);
            return buildRoomEvent({
              roomId: input.roomId,
              userId: auth.userId,
              roomVersion: auth.roomVersion,
              eventType: input.eventType,
              ...withOptionalValue("stateKey", input.stateKey),
              txnId: input.txnId,
              content: input.content,
              ...withOptionalValue("redacts", input.redacts),
              membership,
              createEvent,
              powerLevelsEvent,
              latestEvents,
              serverName: ports.appContext.capabilities.config.serverName,
              generateEventId: (targetServerName, roomVersion) =>
                ports.appContext.capabilities.id.generateEventId(targetServerName, roomVersion),
              now: () => ports.appContext.capabilities.clock.now(),
            });
          },
          persist: async (_pipelineInput, _auth, event) => {
            await ports.repository.storeEvent(event);
            return { eventId: event.event_id };
          },
          fanout: async (_pipelineInput, _auth, event) => {
            await ports.repository.notifyUsersOfEvent(
              input.roomId,
              event.event_id,
              input.eventType,
            );
          },
          notifyFederation: (_pipelineInput, auth, event) => {
            ports.deferRoomAsyncTask(
              logger,
              {
                command: "send_event",
                room_id: input.roomId,
                event_id: event.event_id,
                event_type: input.eventType,
                phase: "fanout_event",
              },
              async () => {
                if (
                  ports.appContext.profile.features.pushNotifications &&
                  (input.eventType === "m.room.message" || input.eventType === "m.room.encrypted")
                ) {
                  await ports.appContext.capabilities.workflow.createPushNotification({
                    eventId: event.event_id,
                    roomId: input.roomId,
                    eventType: input.eventType,
                    sender: input.userId,
                    content: input.content,
                    originServerTs: event.origin_server_ts,
                  });
                }

                const federatedEvent = await ports.attachFederationMetadata(
                  event,
                  auth.roomVersion,
                );
                await emitEffectWarning("[room-service] federating event", {
                  roomId: input.roomId,
                  eventId: federatedEvent.event_id,
                  eventType: input.eventType,
                  hasHashes: Boolean(federatedEvent.hashes?.sha256),
                  signatureServers: Object.keys(federatedEvent.signatures ?? {}),
                  authEvents: federatedEvent.auth_events?.length ?? 0,
                  prevEvents: federatedEvent.prev_events?.length ?? 0,
                });
                await ports.fanoutEventToFederation(input.roomId, federatedEvent);
              },
            );
          },
        });

        const eventId = result.persisted.eventId;
        if (typeof eventId !== "string") {
          throw new MatrixApiError("M_UNKNOWN", "Event persistence failed", 500);
        }
        await runClientEffect(
          logger.info("room.command.success", {
            command: "send_event",
            event_id: eventId,
            event_type: input.eventType,
          }),
        );
        return { event_id: eventId };
      },
    );
    return response as { event_id: string };
  } catch (error) {
    if (error instanceof DomainError) {
      throw toMatrixApiError(error);
    }
    throw error;
  }
}
