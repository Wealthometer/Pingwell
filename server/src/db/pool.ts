import pg from "pg"
import { config } from "../config.js"

// Return BIGINT/NUMERIC counts as numbers, timestamps stay Date.
pg.types.setTypeParser(20, (v) => Number(v))
pg.types.setTypeParser(1700, (v) => Number(v))

let pool: pg.Pool | undefined

export function db(): pg.Pool {
  pool ??= new pg.Pool({
    connectionString: config().DATABASE_URL,
    max: 20,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  })
  return pool
}

export type Queryable = pg.Pool | pg.PoolClient

export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db().connect()
  try {
    await client.query("BEGIN")
    const result = await fn(client)
    await client.query("COMMIT")
    return result
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

export async function closeDb() {
  if (pool) {
    const p = pool
    pool = undefined
    await p.end()
  }
}
