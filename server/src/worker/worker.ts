import { createServer, type Server } from "node:http"
import { Worker } from "bullmq"
import { fetch } from "undici"
import { deliver, findStrandedDeliveries, markDeliveryFailed } from "../alerts/deliver.js"
import { config } from "../config.js"
import { db } from "../db/pool.js"
import { logger } from "../logger.js"
import { runMonitorCheck } from "../monitoring/run-monitor-check.js"
import { schedulerLagSeconds, schedulerTick } from "../monitoring/scheduler.js"
import { createRedis, tryLock } from "../redis.js"
import { enqueueDeliveries, QUEUE, type AlertJob, type CheckJob } from "../queues.js"
import { beat, clearBeat, HEARTBEAT_INTERVAL_MS, recordSchedulerTick, WORKER_ID } from "../system/heartbeat.js"
import { alertsTotal, registry, scheduledTotal, schedulerLag } from "../system/metrics.js"

/**
 * Hosted Redis (Upstash) bills per command, and an idle BullMQ worker is not free: it re-issues its
 * blocking wait every `drainDelay` seconds and runs a stalled-job sweep every `stalledInterval`.
 * New jobs still wake the blocking wait immediately, so longer values cost no check latency.
 */
const WORKER_POLLING = { drainDelay: 30, stalledInterval: 120_000 }
const QUOTA_BACKOFF_MS = 5 * 60_000
const TICK_WRITE_MS = 30_000

export type RunningWorker = {
  /** Stops loops and drains in-flight jobs. Shared DB/Redis/queue connections are left to the caller. */
  stop(): Promise<void>
}

/**
 * Starts the check/alert consumers and the periodic loops. Used by the standalone worker process and,
 * with RUN_WORKER=true, inside the API process (single-instance deployments).
 */
export function startWorker(opts: { metricsPort?: number } = {}): RunningWorker {
  const cfg = config()
  const log = logger.child({ worker: WORKER_ID })
  const startedAt = new Date().toISOString()
  const stats = { checksProcessed: 0, alertsProcessed: 0 }
  const timers: NodeJS.Timeout[] = []
  let stopping = false

  // When the Redis provider rejects commands for quota reasons (e.g. Upstash "max requests limit"),
  // BullMQ retries its fetch loop immediately, which floods the logs and keeps hammering Redis.
  // Pause everything locally and try again later instead.
  let quotaPausedUntil = 0
  let resumeTimer: NodeJS.Timeout | undefined
  const isQuotaError = (msg: string) => /max (daily )?requests? limit|limit exceeded/i.test(msg)
  function backOffForQuota(msg: string) {
    if (stopping || Date.now() < quotaPausedUntil) return
    quotaPausedUntil = Date.now() + QUOTA_BACKOFF_MS
    log.error({ err: msg, retryInSeconds: QUOTA_BACKOFF_MS / 1000 }, "redis quota exceeded: pausing worker")
    for (const w of [checkWorker, alertWorker]) void w.pause(true).catch(() => {})
    resumeTimer = setTimeout(() => {
      if (stopping) return
      log.info("resuming worker after redis quota backoff")
      for (const w of [checkWorker, alertWorker]) w.resume()
    }, QUOTA_BACKOFF_MS)
  }

  // ── Consumers ──────────────────────────────────────────────────────────────

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
    { connection: createRedis(), concurrency: cfg.CHECK_CONCURRENCY, ...WORKER_POLLING },
  )

  const alertWorker = new Worker<AlertJob>(
    QUEUE.alerts,
    async (job) => {
      const outcome = await deliver(job.data.deliveryId)
      stats.alertsProcessed++
      alertsTotal.inc({ outcome })
      return outcome
    },
    { connection: createRedis(), concurrency: 10, ...WORKER_POLLING },
  )

  alertWorker.on("failed", async (job, err) => {
    alertsTotal.inc({ outcome: "error" })
    if (!job) return
    const attempts = job.opts.attempts ?? 1
    log.warn({ deliveryId: job.data.deliveryId, attempt: job.attemptsMade, of: attempts, err: err.message }, "alert delivery failed")
    if (job.attemptsMade >= attempts) await markDeliveryFailed(job.data.deliveryId, err.message).catch((e) => log.error(e))
  })
  checkWorker.on("failed", (job, err) => log.error({ monitorId: job?.data.monitorId, err: err.message }, "check job failed"))
  for (const w of [checkWorker, alertWorker])
    w.on("error", (err) => {
      if (isQuotaError(err.message)) return backOffForQuota(err.message)
      if (Date.now() < quotaPausedUntil) return // errors from jobs that were in flight when we paused
      log.error({ err: err.message }, "worker error")
    })

  // ── Loops ──────────────────────────────────────────────────────────────────

  function every(ms: number, name: string, fn: () => Promise<void>) {
    let running = false
    const run = async () => {
      if (running || stopping || Date.now() < quotaPausedUntil) return
      running = true
      try {
        await fn()
      } catch (err) {
        const msg = (err as Error).message
        if (isQuotaError(msg)) backOffForQuota(msg)
        else log.error({ err: msg, loop: name }, "loop failed")
      } finally {
        running = false
      }
    }
    timers.push(setInterval(run, ms))
    void run()
  }

  let lastTickWrite = 0
  // Scheduler: safe to run in every worker thanks to SKIP LOCKED.
  every(cfg.SCHEDULER_INTERVAL_MS, "scheduler", async () => {
    const n = await schedulerTick(cfg.SCHEDULER_BATCH_SIZE)
    if (n) scheduledTotal.inc(n)
    schedulerLag.set(await schedulerLagSeconds())
    // The tick only feeds the health check (stale after 60s), so don't write it on every 5s pass.
    if (Date.now() - lastTickWrite >= TICK_WRITE_MS) {
      await recordSchedulerTick()
      lastTickWrite = Date.now()
    }
  })

  every(HEARTBEAT_INTERVAL_MS, "heartbeat", () => beat({ startedAt, ...stats }))

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

  // ── Metrics endpoint (standalone worker only; the API already serves /metrics) ──

  let metricsServer: Server | undefined
  if (opts.metricsPort !== undefined) {
    metricsServer = createServer(async (req, res) => {
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
    }).listen(opts.metricsPort)
  }
  log.info({ port: opts.metricsPort, concurrency: cfg.CHECK_CONCURRENCY }, "worker started")

  return {
    async stop() {
      if (stopping) return
      stopping = true
      log.info("worker stopping: finishing in-flight jobs")
      timers.forEach(clearInterval)
      clearTimeout(resumeTimer)
      await Promise.allSettled([checkWorker.close(), alertWorker.close()])
      await clearBeat().catch(() => {})
      metricsServer?.close()
    },
  }
}
