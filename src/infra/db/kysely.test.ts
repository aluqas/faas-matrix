import { describe, expect, it, vi } from "vitest";
import {
  compileKyselyQuery,
  executeKyselyBatch,
  executeKyselyRun,
  type CompiledQuery,
} from "./kysely";

function createCompiledQuery(sql: string, parameters: readonly unknown[] = []): CompiledQuery {
  return {
    compile: () => ({ sql, parameters }),
  };
}

describe("kysely helpers", () => {
  it("compiles query objects into raw sql and parameters", () => {
    expect(compileKyselyQuery(createCompiledQuery("select 1", [1]))).toEqual({
      sql: "select 1",
      parameters: [1],
    });
  });

  it("executes batch statements through db.batch", async () => {
    const bind = vi.fn().mockReturnValue("prepared");
    const prepare = vi.fn(() => ({ bind }));
    const batch = vi.fn(async () => []);
    const db = { prepare, batch } as unknown as D1Database;

    await executeKyselyBatch(db, [
      createCompiledQuery("insert into foo values (?)", [1]),
      createCompiledQuery("update foo set bar = ?", [2]),
    ]);

    expect(prepare).toHaveBeenCalledTimes(2);
    expect(bind).toHaveBeenNthCalledWith(1, 1);
    expect(bind).toHaveBeenNthCalledWith(2, 2);
    expect(batch).toHaveBeenCalledWith(["prepared", "prepared"]);
  });

  it("executes single run statements through prepare/bind/run", async () => {
    const run = vi.fn(async () => undefined);
    const bind = vi.fn(() => ({ run }));
    const prepare = vi.fn(() => ({ bind }));
    const db = { prepare } as unknown as D1Database;

    await executeKyselyRun(db, createCompiledQuery("delete from foo where id = ?", [3]));

    expect(prepare).toHaveBeenCalledWith("delete from foo where id = ?");
    expect(bind).toHaveBeenCalledWith(3);
    expect(run).toHaveBeenCalled();
  });
});
