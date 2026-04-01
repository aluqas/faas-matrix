import { Effect } from "effect";
import type { Context } from "hono";
import type { AppEnv } from "../types";
import { withLogContext } from "../matrix/application/logging";
import { toErrorResponse } from "../utils/errors";

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
