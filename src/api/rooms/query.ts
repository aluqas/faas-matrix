import { Hono } from "hono";
import type { AppEnv } from "../../types";
import { Errors } from "../../utils/errors";
import { requireAuth } from "../../middleware/auth";
import { getMembership } from "../../services/database";
import { EventQueryService } from "../../matrix/application/event-query-service";

const app = new Hono<AppEnv>();
const queries = new EventQueryService();

app.get("/_matrix/client/v3/rooms/:roomId/timestamp_to_event", requireAuth(), async (c) => {
  const userId = c.get("userId");
  const roomId = c.req.param("roomId");

  const tsParam = c.req.query("ts");
  const dirParam = c.req.query("dir");

  if (!tsParam) {
    return Errors.missingParam("ts").toResponse();
  }
  if (!dirParam) {
    return Errors.missingParam("dir").toResponse();
  }

  const ts = Number.parseInt(tsParam, 10);
  if (Number.isNaN(ts)) {
    return c.json(
      {
        errcode: "M_INVALID_PARAM",
        error: "ts must be a valid integer timestamp in milliseconds",
      },
      400,
    );
  }

  if (dirParam !== "f" && dirParam !== "b") {
    return c.json(
      {
        errcode: "M_INVALID_PARAM",
        error: "dir must be 'f' (forward) or 'b' (backward)",
      },
      400,
    );
  }

  const membership = await getMembership(c.env.DB, roomId, userId);
  if (!membership || membership.membership !== "join") {
    return Errors.forbidden("Not a member of this room").toResponse();
  }

  const event = await queries.findClosestEventByTimestamp(c.env.DB, roomId, ts, dirParam);
  if (!event) {
    return Errors.notFound("No event found for the given timestamp").toResponse();
  }

  return c.json(event);
});

export default app;
