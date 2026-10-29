import { config } from "../config.js"
import { setService } from "../logger.js"
import { closeDb } from "../db/pool.js"
import { closeQueues } from "../queues.js"
import { closeRedis } from "../redis.js"
import { startWorker } from "../worker/worker.js"
import { buildApp } from "./app.js"

setService("api")
const cfg = config()
const app = await buildApp()
await app.listen({ host: cfg.HOST, port: cfg.PORT })
// Single-instance mode: run checks in this process instead of a separate worker service.
const worker = cfg.RUN_WORKER ? startWorker() : undefined

let stopping = false
async function shutdown(signal: string) {
  if (stopping) return
  stopping = true
  app.log.info({ signal }, "shutting down")
  const force = setTimeout(() => process.exit(1), worker ? 30_000 : 15_000)
  force.unref()
  await app.close() // stops accepting, drains in-flight requests
  await worker?.stop() // finishes in-flight checks before connections close
  await closeQueues()
  await closeRedis()
  await closeDb()
  process.exit(0)
}
process.on("SIGTERM", () => void shutdown("SIGTERM"))
process.on("SIGINT", () => void shutdown("SIGINT"))
