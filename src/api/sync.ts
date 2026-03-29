// Matrix sync endpoint

import { Hono } from "hono";
import type { AppEnv } from "../types";
import { Errors } from "../utils/errors";
import { requireAuth } from "../middleware/auth";

const app = new Hono<AppEnv>();

app.get("/_matrix/client/v3/sync", requireAuth(), async (c) => {
  try {
    const response = await c.get("appContext").services.sync.syncUser({
      userId: c.get("userId"),
      deviceId: c.get("deviceId"),
      since: c.req.query("since"),
      fullState: c.req.query("full_state") === "true",
      filterParam: c.req.query("filter"),
      timeout: Number.parseInt(c.req.query("timeout") || "0", 10) || 0,
    });
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
