import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { MatrixApiError } from "../../utils/errors";
import { DomainError, InfraError } from "./domain-error";
import { runClientEffect, runFederationEffect } from "./effect-runtime";

describe("effect runtime", () => {
  it("returns successful effects unchanged", async () => {
    await expect(runClientEffect(Effect.succeed("ok"))).resolves.toBe("ok");
  });

  it("maps domain errors to MatrixApiError", async () => {
    const effect = Effect.fail(
      new DomainError({
        kind: "spec_violation",
        errcode: "M_BAD_JSON",
        message: "bad input",
        status: 400,
      }),
    );

    await expect(runClientEffect(effect)).rejects.toMatchObject(
      expect.objectContaining<Partial<MatrixApiError>>({
        errcode: "M_BAD_JSON",
        message: "bad input",
        status: 400,
      }),
    );
  });

  it("maps infrastructure errors to MatrixApiError", async () => {
    const effect = Effect.fail(
      new InfraError({
        errcode: "M_UNKNOWN",
        message: "transport down",
        status: 502,
      }),
    );

    await expect(runFederationEffect(effect)).rejects.toMatchObject(
      expect.objectContaining<Partial<MatrixApiError>>({
        errcode: "M_UNKNOWN",
        message: "transport down",
        status: 502,
      }),
    );
  });
});
