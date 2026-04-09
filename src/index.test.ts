import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "./shared/types";
import { handleAppError } from "./platform/cloudflare/http-error-handler";
import { Errors } from "./shared/utils/errors";

describe("handleAppError", () => {
  it("returns MatrixApiError responses without converting them to 500", async () => {
    const app = new Hono<AppEnv>();
    app.onError(handleAppError);
    app.get("/matrix-error", () => {
      throw Errors.forbidden("State keys beginning with '@' are reserved");
    });

    const response = await app.request("http://localhost/matrix-error");

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      errcode: "M_FORBIDDEN",
      error: "State keys beginning with '@' are reserved",
    });
  });

  it("keeps unexpected errors as 500", async () => {
    const app = new Hono<AppEnv>();
    app.onError(handleAppError);
    app.get("/unexpected-error", () => {
      throw new Error("boom");
    });

    const response = await app.request("http://localhost/unexpected-error");

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      errcode: "M_UNKNOWN",
      error: "An internal error occurred",
    });
  });
});
