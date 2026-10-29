import { config } from "../config.js"
import { setService } from "../logger.js"
import { closeDb } from "../db/pool.js"
import { closeQueues } from "../queues.js"
import { closeRedis } from "../redis.js"
import { buildApp } from "./app.js"

setService("api")
const cfg = config()
const app = await buildApp()
await app.listen({ host: cfg.HOST, port: cfg.PORT })

let stopping = false
async function shutdown(signal: string) {
  if (stopping) return
  stopping = true
  app.log.info({ signal }, "shutting down")
  const force = setTimeout(() => process.exit(1), 15_000)
  force.unref()
  await app.close() // stops accepting, drains in-flight requests
  await closeQueues()
  await closeRedis()
  await closeDb()
  process.exit(0)
}
process.on("SIGTERM", () => void shutdown("SIGTERM"))
process.on("SIGINT", () => void shutdown("SIGINT"))
