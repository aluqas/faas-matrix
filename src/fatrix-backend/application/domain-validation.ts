import type { Effect } from "effect";
import type { DomainError } from "./domain-error";
import { runFederationEffect } from "./runtime/effect-runtime";

export function runDomainValidation<A>(effect: Effect.Effect<A, DomainError>): Promise<A> {
  return runFederationEffect(effect);
}
