import type { Env } from "../../../../types";
import { federationPut } from "../../../../services/federation-keys";
import { emitEffectWarning, traceEffectPromise, truncateDebugText } from "../../effect-debug";

export const FEDERATION_OUTBOUND_DO_NAME = "outbound";

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("Federation EDU send timed out")), timeoutMs);
    }),
  ]);
}

export async function queueFederationEdu(
  env: Env,
  destination: string,
  eduType: string,
  content: object,
): Promise<void> {
  await emitEffectWarning("[federation-edu-queue] queue", {
    destination,
    eduType,
  });
  try {
    const result = await traceEffectPromise(
      "[federation-edu-queue] direct send",
      {
        destination,
        eduType,
      },
      async () => {
        const response = await withTimeout(
          federationPut(
            destination,
            `/_matrix/federation/v1/send/${Date.now()}-0`,
            {
              pdus: [],
              edus: [{ edu_type: eduType, content }],
            },
            env.SERVER_NAME,
            env.DB,
            env.CACHE,
          ),
          1500,
        );
        const responseBody = await response
          .clone()
          .text()
          .catch((error) =>
            error instanceof Error ? `<unavailable:${error.message}>` : "<unavailable>",
          );
        return {
          ok: response.ok,
          status: response.status,
          responseBody: truncateDebugText(responseBody),
        };
      },
      {
        onSuccess: (value) => value,
      },
    );

    if (result.ok) {
      await emitEffectWarning("[federation-edu-queue] sent", {
        destination,
        eduType,
        attempt: 0,
      });
      return;
    }
    await emitEffectWarning("[federation-edu-queue] non-ok response", {
      destination,
      eduType,
      attempt: 0,
      status: result.status,
      responseBody: result.responseBody,
    });
  } catch {
    // Fall back to the queued DO path when direct delivery is slow or unavailable.
  }

  await emitEffectWarning("[federation-edu-queue] falling back to durable object queue", {
    destination,
    eduType,
  });
  const stub = env.FEDERATION.get(env.FEDERATION.idFromName(FEDERATION_OUTBOUND_DO_NAME));
  await stub.fetch(
    new Request("http://internal/send-edu", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        destination,
        edu_type: eduType,
        content,
      }),
    }),
  );
}
