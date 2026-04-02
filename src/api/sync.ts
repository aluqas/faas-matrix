// Matrix sync endpoint

import { Hono } from "hono";
import type { AppEnv } from "../types";
import { Errors } from "../utils/errors";
import { requireAuth } from "../middleware/auth";
import { runClientEffect } from "../matrix/application/effect-runtime";
import type { SyncUserInput } from "../matrix/application/features/sync/contracts";

const app = new Hono<AppEnv>();

app.get("/_matrix/client/v3/sync", requireAuth(), async (c) => {
  try {
    const since = c.req.query("since");
    const filterParam = c.req.query("filter");
    const input: SyncUserInput = {
      userId: c.get("userId"),
      deviceId: c.get("deviceId"),
      fullState: c.req.query("full_state") === "true",
      timeout: Number.parseInt(c.req.query("timeout") || "0", 10) || 0,
      ...(since ? { since } : {}),
      ...(filterParam ? { filterParam } : {}),
    };
    const response = await runClientEffect(c.get("appContext").services.sync.syncUser(input));
    return c.json(response);
  } catch (error) {
    if (error instanceof Error && "toResponse" in error) {
      return (error as { toResponse(): Response }).toResponse();
    }
    if (error instanceof SyntaxError) {
      return Errors.badJson().toResponse();
    }
    throw error;
  }
});

export default app;
