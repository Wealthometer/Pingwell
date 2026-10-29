import { createServer } from "node:http"
import { Worker } from "bullmq"
import { fetch } from "undici"
import { deliver, findStrandedDeliveries, markDeliveryFailed } from "../alerts/deliver.js"
import { config } from "../config.js"
import { closeDb, db } from "../db/pool.js"
import { logger, setService } from "../logger.js"
import { runMonitorCheck } from "../monitoring/run-monitor-check.js"
import { schedulerLagSeconds, schedulerTick } from "../monitoring/scheduler.js"
import { closeQueues, enqueueDeliveries, QUEUE, type AlertJob, type CheckJob } from "../queues.js"
import { closeRedis, createRedis, tryLock } from "../redis.js"
import { beat, clearBeat, recordSchedulerTick, WORKER_ID } from "../system/heartbeat.js"
import { alertsTotal, registry, scheduledTotal, schedulerLag } from "../system/metrics.js"

setService("worker")
const cfg = config()
const log = logger.child({ worker: WORKER_ID })
const startedAt = new Date().toISOString()
const stats = { checksProcessed: 0, alertsProcessed: 0 }
const timers: NodeJS.Timeout[] = []
let stopping = false

// ── Consumers ────────────────────────────────────────────────────────────────

const checkWorker = new Worker<CheckJob>(
  QUEUE.checks,
  async (job) => {
    const result = await runMonitorCheck(job.data.monitorId)
    stats.checksProcessed++
    if (result.deliveryIds.length) await enqueueDeliveries(result.deliveryIds)
    if (result.action && result.action !== "none") {
      log.info({ monitorId: job.data.monitorId, action: result.action, incidentId: result.incidentId }, "incident transition")
    }
    return { status: result.status, action: result.action }
  },
  { connection: createRedis(), concurrency: cfg.CHECK_CONCURRENCY },
)

const alertWorker = new Worker<AlertJob>(
  QUEUE.alerts,
  async (job) => {
    const outcome = await deliver(job.data.deliveryId)
    stats.alertsProcessed++
    alertsTotal.inc({ outcome })
    return outcome
  },
  { connection: createRedis(), concurrency: 10 },
)

alertWorker.on("failed", async (job, err) => {
  alertsTotal.inc({ outcome: "error" })
  if (!job) return
  const attempts = job.opts.attempts ?? 1
  log.warn({ deliveryId: job.data.deliveryId, attempt: job.attemptsMade, of: attempts, err: err.message }, "alert delivery failed")
  if (job.attemptsMade >= attempts) await markDeliveryFailed(job.data.deliveryId, err.message).catch((e) => log.error(e))
})
checkWorker.on("failed", (job, err) => log.error({ monitorId: job?.data.monitorId, err: err.message }, "check job failed"))
for (const w of [checkWorker, alertWorker]) w.on("error", (err) => log.error({ err: err.message }, "worker error"))

// ── Loops ────────────────────────────────────────────────────────────────────

function every(ms: number, name: string, fn: () => Promise<void>) {
  let running = false
  const run = async () => {
    if (running || stopping) return
    running = true
    try {
      await fn()
    } catch (err) {
      log.error({ err: (err as Error).message, loop: name }, "loop failed")
    } finally {
      running = false
    }
  }
  timers.push(setInterval(run, ms))
  void run()
}

// Scheduler: safe to run in every worker thanks to SKIP LOCKED.
every(cfg.SCHEDULER_INTERVAL_MS, "scheduler", async () => {
  const n = await schedulerTick(cfg.SCHEDULER_BATCH_SIZE)
  if (n) scheduledTotal.inc(n)
  schedulerLag.set(await schedulerLagSeconds())
  await recordSchedulerTick()
})

every(10_000, "heartbeat", () => beat({ startedAt, ...stats }))

// Outbox sweeper: re-queue alert deliveries that were committed but never enqueued (e.g. crash).
every(60_000, "outbox", async () => {
  if (!(await tryLock("outbox", 55_000, WORKER_ID))) return
  const ids = await findStrandedDeliveries(60)
  if (ids.length) {
    log.warn({ count: ids.length }, "re-enqueueing stranded alert deliveries")
    await enqueueDeliveries(ids)
  }
})

// Retention: delete old check results in small batches so we never hold long locks.
every(60 * 60_000, "retention", async () => {
  if (!(await tryLock("retention", 55 * 60_000, WORKER_ID))) return
  let total = 0
  for (;;) {
    const res = await db().query(
      `DELETE FROM check_results WHERE id IN (
         SELECT id FROM check_results WHERE checked_at < now() - make_interval(days => $1) LIMIT 5000)`,
      [cfg.RESULT_RETENTION_DAYS],
    )
    total += res.rowCount ?? 0
    if ((res.rowCount ?? 0) < 5000) break
  }
  if (total) log.info({ deleted: total }, "pruned old check results")
})

// Dead man's switch: if Pingwell itself stops, the external service notices the missing ping.
if (cfg.HEARTBEAT_URL) {
  const url = cfg.HEARTBEAT_URL
  every(60_000, "deadman", async () => {
    if (!(await tryLock("deadman", 55_000, WORKER_ID))) return
    await fetch(url, { method: "GET", signal: AbortSignal.timeout(10_000) })
  })
}

// ── Metrics endpoint ─────────────────────────────────────────────────────────

const metricsServer = createServer(async (req, res) => {
  if (req.url === "/metrics") {
    res.setHeader("content-type", registry.contentType)
    res.end(await registry.metrics())
  } else if (req.url === "/health") {
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify({ ok: !stopping, worker: WORKER_ID, ...stats }))
  } else {
    res.statusCode = 404
    res.end()
  }
}).listen(cfg.WORKER_METRICS_PORT, () => log.info({ port: cfg.WORKER_METRICS_PORT, concurrency: cfg.CHECK_CONCURRENCY }, "worker started"))

// ── Graceful shutdown ────────────────────────────────────────────────────────

async function shutdown(signal: string) {
  if (stopping) return
  stopping = true
  log.info({ signal }, "shutting down: finishing in-flight jobs")
  timers.forEach(clearInterval)
  const force = setTimeout(() => process.exit(1), 30_000)
  force.unref()
  await Promise.allSettled([checkWorker.close(), alertWorker.close()])
  await clearBeat().catch(() => {})
  metricsServer.close()
  await closeQueues()
  await closeRedis()
  await closeDb()
  log.info("bye")
  process.exit(0)
}
process.on("SIGTERM", () => void shutdown("SIGTERM"))
process.on("SIGINT", () => void shutdown("SIGINT"))
