// Matrix sync endpoint

import { Hono } from "hono";
import type { AppEnv } from "../shared/types";
import { Errors } from "../shared/utils/errors";
import { requireAuth } from "../infra/middleware/auth";
import { runClientEffect } from "../matrix/application/runtime/effect-runtime";
import type { SyncUserInput } from "../features/sync/contracts";

const app = new Hono<AppEnv>();

app.get("/_matrix/client/v3/sync", requireAuth(), async (c) => {
  try {
    const since = c.req.query("since");
    const filterParam = c.req.query("filter");
    const rawSetPresence = c.req.query("set_presence");
    let setPresence: SyncUserInput["setPresence"];
    if (
      rawSetPresence &&
      rawSetPresence !== "online" &&
      rawSetPresence !== "offline" &&
      rawSetPresence !== "unavailable"
    ) {
      return Errors.invalidParam(
        "set_presence",
        "set_presence must be one of: online, offline, unavailable",
      ).toResponse();
    }
    if (rawSetPresence) {
      setPresence = rawSetPresence as SyncUserInput["setPresence"];
    }
    const input: SyncUserInput = {
      userId: c.get("userId"),
      deviceId: c.get("deviceId"),
      fullState: c.req.query("full_state") === "true",
      timeout: Number.parseInt(c.req.query("timeout") ?? "0", 10) || 0,
      ...(since ? { since } : {}),
      ...(filterParam ? { filterParam } : {}),
      ...(setPresence ? { setPresence } : {}),
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
