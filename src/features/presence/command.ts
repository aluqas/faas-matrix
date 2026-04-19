import { Effect } from "effect";
import type { PresenceCommandInput, PresenceCommandPorts } from "./contracts";
import { withLogContext } from "../../matrix/application/logging";
import { InfraError } from "../../matrix/application/domain-error";
import { fromInfraPromise, fromInfraVoid } from "../../shared/effect/infra-effect";
import type { ServerName, UserId } from "../../shared/types";
import type { PresenceEduContent } from "./contracts";

export interface PresenceCommandEffectPorts {
  localServerName: ServerName;
  debugEnabled?: boolean | undefined;
  presenceStore: {
    persistPresence(input: PresenceCommandInput): Effect.Effect<void, InfraError>;
  };
  interestedServers: {
    listInterestedServers(userId: UserId): Effect.Effect<ServerName[], InfraError>;
  };
  federation: {
    queuePresenceEdu(
      destination: ServerName,
      content: PresenceEduContent,
    ): Effect.Effect<void, InfraError>;
  };
}

function createCompatibilityPresencePorts(ports: PresenceCommandPorts): PresenceCommandEffectPorts {
  return {
    localServerName: ports.localServerName,
    debugEnabled: ports.debugEnabled,
    presenceStore: {
      persistPresence: (input) =>
        fromInfraVoid(
          () => Promise.resolve(ports.persistPresence(input)),
          "Failed to persist presence",
        ),
    },
    interestedServers: {
      listInterestedServers: (userId) =>
        fromInfraPromise(
          () => Promise.resolve(ports.resolveInterestedServers(userId)),
          "Failed to resolve presence destinations",
        ),
    },
    federation: {
      queuePresenceEdu: (destination, content) =>
        fromInfraVoid(
          () => Promise.resolve(ports.queueEdu(destination, content)),
          "Failed to queue presence EDU",
        ),
    },
  };
}

export function executePresenceCommandEffect(
  input: PresenceCommandInput,
  ports: PresenceCommandEffectPorts,
): Effect.Effect<void, InfraError> {
  const logger = withLogContext({
    component: "presence",
    operation: "command",
    user_id: input.userId,
    debugEnabled: ports.debugEnabled,
  });

  return Effect.gen(function* () {
    yield* logger.info("presence.command.start", {
      presence: input.presence,
      has_status_message: Boolean(input.statusMessage),
    });

    yield* ports.presenceStore.persistPresence(input);

    const interestedServers = yield* ports.interestedServers.listInterestedServers(input.userId);
    const destinations = [...new Set(interestedServers)].filter(
      (server) => server !== ports.localServerName,
    );
    yield* logger.debug("presence.command.resolve_destinations", {
      destination_count: destinations.length,
      destinations,
    });

    if (destinations.length === 0) {
      yield* logger.info("presence.command.success", { destination_count: 0 });
      return;
    }

    const content: PresenceEduContent = {
      push: [
        {
          user_id: input.userId,
          presence: input.presence,
          status_msg: input.statusMessage ?? undefined,
          last_active_ago: 0,
          currently_active: input.presence === "online",
        },
      ],
    };

    for (const destination of destinations) {
      yield* ports.federation.queuePresenceEdu(destination, content);
    }

    yield* logger.info("presence.command.success", {
      destination_count: destinations.length,
    });
  });
}

export function executePresenceCommand(
  input: PresenceCommandInput,
  ports: PresenceCommandPorts,
): Promise<void> {
  return Effect.runPromise(
    executePresenceCommandEffect(input, createCompatibilityPresencePorts(ports)),
  );
}

export function setPresenceStatusEffect(
  ports: PresenceCommandEffectPorts,
  input: PresenceCommandInput,
): Effect.Effect<void, InfraError> {
  return executePresenceCommandEffect(input, ports);
}
