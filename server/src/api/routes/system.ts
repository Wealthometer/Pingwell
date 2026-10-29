import type { FastifyInstance } from "fastify"
import { config } from "../../config.js"
import { db } from "../../db/pool.js"
import { schedulerLagSeconds } from "../../monitoring/scheduler.js"
import { alertQueue, checkQueue } from "../../queues.js"
import { redis } from "../../redis.js"
import { lastSchedulerTick, liveWorkers } from "../../system/heartbeat.js"
import { queueDepth, registry } from "../../system/metrics.js"

async function queueCounts() {
  const [checks, alerts] = await Promise.all([
    checkQueue().getJobCounts("waiting", "active", "delayed", "failed"),
    alertQueue().getJobCounts("waiting", "active", "delayed", "failed"),
  ])
  return { checks, alerts }
}

/**
 * Monitoring the monitor: is anything actually running checks? Healthy needs a live worker, a
 * recent scheduler tick and a short backlog.
 */
export async function systemStatus() {
  const [workers, tick, lag, queues] = await Promise.all([liveWorkers(), lastSchedulerTick(), schedulerLagSeconds(), queueCounts()])
  const tickAge = tick ? (Date.now() - tick.getTime()) / 1000 : null
  const problems: string[] = []
  if (workers.length === 0) problems.push("No workers are running, so no checks are happening")
  if (tickAge === null || tickAge > 60) problems.push(tickAge === null ? "The scheduler has never run" : `The scheduler last ran ${Math.round(tickAge)}s ago`)
  if (lag > 120) problems.push(`Checks are running ${Math.round(lag)}s behind schedule`)
  const failedAlerts = queues.alerts.failed ?? 0
  if (failedAlerts > 0) problems.push(`${failedAlerts} alert deliveries failed recently`)
  const verdict = workers.length === 0 || (tickAge ?? Infinity) > 120 ? "down" : problems.length ? "degraded" : "healthy"
  return { verdict, problems, workers, schedulerLastTick: tick, schedulerLagSeconds: Math.round(lag), queues }
}

export async function systemRoutes(app: FastifyInstance) {
  // Liveness: the process is up.
  app.get("/health", async () => ({ ok: true }))

  // Readiness: dependencies are reachable. Load balancers should route on this.
  app.get("/health/ready", async (_req, reply) => {
    const checks = await Promise.allSettled([db().query("SELECT 1"), redis().ping()])
    const [pg, rd] = checks.map((c) => c.status === "fulfilled")
    if (!pg || !rd) return reply.code(503).send({ ok: false, postgres: pg, redis: rd })
    return { ok: true, postgres: true, redis: true }
  })

  app.get("/metrics", async (req, reply) => {
    const token = config().METRICS_TOKEN
    if (token && req.headers.authorization !== `Bearer ${token}`) return reply.code(401).send({ error: "Unauthorized" })
    const q = await queueCounts().catch(() => null)
    if (q) {
      for (const [queue, counts] of Object.entries(q))
        for (const [state, n] of Object.entries(counts)) queueDepth.set({ queue, state }, n)
    }
    reply.header("content-type", registry.contentType)
    return registry.metrics()
  })

  app.get("/api/system", { onRequest: [app.authenticate] }, async () => systemStatus())
}
