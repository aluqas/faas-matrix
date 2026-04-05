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

export async function executeKyselyQuery<T>(db: D1Database, query: CompiledQuery): Promise<T[]> {
  const { sql, parameters } = query.compile();
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
  const { sql, parameters } = query.compile();
  await db
    .prepare(sql)
    .bind(...parameters)
    .run();
}
