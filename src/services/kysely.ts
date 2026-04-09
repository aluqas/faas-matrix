import {
  DummyDriver,
  Kysely,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
} from "kysely";

/**
 * Creates a compile-only Kysely instance backed by the SQLite dialect.
 * No real database connection is established; the instance is used purely
 * for type-safe query construction. Compiled queries are executed against D1
 * via executeKyselyQuery / executeKyselyQueryFirst.
 */
export function createKyselyBuilder<T>(): Kysely<T> {
  return new Kysely<T>({
    dialect: {
      createDriver: () => new DummyDriver(),
      createAdapter: () => new SqliteAdapter(),
      createQueryCompiler: () => new SqliteQueryCompiler(),
      createIntrospector: (db) => new SqliteIntrospector(db),
    },
  });
}

export interface CompiledQuery {
  compile(): { sql: string; parameters: readonly unknown[] };
}

export function compileKyselyQuery(query: CompiledQuery): {
  sql: string;
  parameters: readonly unknown[];
} {
  return query.compile();
}

export async function executeKyselyQuery<T>(db: D1Database, query: CompiledQuery): Promise<T[]> {
  const { sql, parameters } = compileKyselyQuery(query);
  const result = await db
    .prepare(sql)
    .bind(...parameters)
    .all<T>();
  return result.results;
}

export async function executeKyselyQueryFirst<T>(
  db: D1Database,
  query: CompiledQuery,
): Promise<T | null> {
  const results = await executeKyselyQuery<T>(db, query);
  return results[0] ?? null;
}

export async function executeKyselyRun(db: D1Database, query: CompiledQuery): Promise<void> {
  const { sql, parameters } = compileKyselyQuery(query);
  await db
    .prepare(sql)
    .bind(...parameters)
    .run();
}

export async function executeKyselyBatch(
  db: D1Database,
  queries: readonly CompiledQuery[],
): Promise<void> {
  await db.batch(
    queries.map((query) => {
      const { sql, parameters } = compileKyselyQuery(query);
      return db.prepare(sql).bind(...parameters);
    }),
  );
}
