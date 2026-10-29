import { readdir, readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { closeDb, db } from "./pool.js"

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations")
const LOCK_ID = 727_001 // arbitrary advisory lock key so parallel deploys don't race

export async function migrate(log: (msg: string) => void = console.log): Promise<string[]> {
  const client = await db().connect()
  const applied: string[] = []
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_ID])
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`)
    const done = new Set((await client.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name))
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort()

    for (const file of files) {
      if (done.has(file)) continue
      const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8")
      await client.query("BEGIN")
      try {
        await client.query(sql)
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file])
        await client.query("COMMIT")
      } catch (err) {
        await client.query("ROLLBACK")
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`)
      }
      applied.push(file)
      log(`applied ${file}`)
    }
    if (applied.length === 0) log("database is up to date")
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_ID]).catch(() => {})
    client.release()
  }
  return applied
}

// Run directly: `npm run migrate`
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  migrate()
    .then(() => closeDb())
    .catch(async (err) => {
      console.error(err)
      await closeDb()
      process.exit(1)
    })
}
