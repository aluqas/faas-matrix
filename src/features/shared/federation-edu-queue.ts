import { Effect } from "effect";
import type { Env } from "../../shared/types";
import { createFederationOutboundPort } from "../../infra/federation/federation-outbound";
import { emitEffectWarningEffect } from "../../matrix/application/runtime/effect-debug";

export interface FederationEduQueuePorts {
  runEffect<A, E>(effect: Effect.Effect<A, E>): Promise<A>;
  enqueue(destination: string, eduType: string, content: object): Promise<void>;
}

export function createFederationEduQueuePorts(env: Env): FederationEduQueuePorts {
  const outbound = createFederationOutboundPort(env);
  return {
    runEffect: Effect.runPromise,
    async enqueue(destination, eduType, content) {
      await outbound.enqueueEdu({
        destination,
        eduType,
        content: content as Record<string, unknown>,
      });
    },
  };
}

export async function queueFederationEduWithPorts(
  ports: FederationEduQueuePorts,
  destination: string,
  eduType: string,
  content: object,
): Promise<void> {
  await ports.runEffect(
    emitEffectWarningEffect("[federation-edu-queue] queue", {
      destination,
      eduType,
    }),
  );
  await ports.enqueue(destination, eduType, content);
  await ports.runEffect(
    emitEffectWarningEffect("[federation-edu-queue] enqueued", {
      destination,
      eduType,
    }),
  );
}

export async function queueFederationEdu(
  env: Env,
  destination: string,
  eduType: string,
  content: object,
): Promise<void> {
  await queueFederationEduWithPorts(
    createFederationEduQueuePorts(env),
    destination,
    eduType,
    content,
  );
}
