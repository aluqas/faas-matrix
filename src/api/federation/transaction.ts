import { Hono } from "hono";
import type { AppEnv } from "../../types";
import { Errors } from "../../utils/errors";

const app = new Hono<AppEnv>();

app.put("/_matrix/federation/v1/send/:txnId", async (c) => {
  const txnId = c.req.param("txnId");
  const origin = c.get("federationOrigin" as any) as string | undefined;
  if (!origin) {
    return Errors.unauthorized("Federation authentication required").toResponse();
  }

  try {
    const body = await c.req.json();
    const response = await c.get("appContext").services.federation.processTransaction({
      origin,
      txnId,
      body,
    });
    return c.json(response);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return Errors.badJson().toResponse();
    }
    if (error instanceof Error && "toResponse" in error) {
      return (error as { toResponse(): Response }).toResponse();
    }
    throw error;
  }
});

export default app;
