import { config } from "../config.js"
import { closeDb } from "../db/pool.js"
import { logger, setService } from "../logger.js"
import { closeQueues } from "../queues.js"
import { closeRedis } from "../redis.js"
import { startWorker } from "./worker.js"

setService("worker")
const worker = startWorker({ metricsPort: config().WORKER_METRICS_PORT })

// ── Graceful shutdown ────────────────────────────────────────────────────────

let stopping = false
async function shutdown(signal: string) {
  if (stopping) return
  stopping = true
  logger.info({ signal }, "shutting down: finishing in-flight jobs")
  const force = setTimeout(() => process.exit(1), 30_000)
  force.unref()
  await worker.stop()
  await closeQueues()
  await closeRedis()
  await closeDb()
  logger.info("bye")
  process.exit(0)
}
process.on("SIGTERM", () => void shutdown("SIGTERM"))
process.on("SIGINT", () => void shutdown("SIGINT"))
