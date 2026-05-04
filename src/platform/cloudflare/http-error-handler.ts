import { Effect } from "effect";
import type { Context } from "hono";
import type { AppEnv } from "../../fatrix-api/hono-env";
import { withLogContext } from "../../fatrix-backend/application/logging";
import { toErrorResponse } from "../../fatrix-model/utils/errors";

export function handleAppError(err: Error, c: Context<AppEnv>) {
  const response = toErrorResponse(err);
  const logger = withLogContext({
    component: "app",
    operation: "http_error",
    user_id: c.get("userId"),
  });
  Effect.runSync(
    logger.error("app.error.unhandled", err, {
      method: c.req.method,
      path: c.req.path,
      status: response?.status,
    }),
  );
  if (response) {
    return response;
  }
  return c.json(
    {
      errcode: "M_UNKNOWN",
      error: "An internal error occurred",
    },
    500,
  );
}
