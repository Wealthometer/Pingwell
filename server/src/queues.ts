import { Queue } from "bullmq"
import { createRedis } from "./redis.js"

export const QUEUE = {
  checks: "pingwell-checks",
  alerts: "pingwell-alerts",
} as const

export type CheckJob = { monitorId: string; reason: "scheduled" | "manual" }
export type AlertJob = { deliveryId: number }

let checks: Queue<CheckJob> | undefined
let alerts: Queue<AlertJob> | undefined

export function checkQueue(): Queue<CheckJob> {
  checks ??= new Queue<CheckJob>(QUEUE.checks, {
    connection: createRedis(),
    defaultJobOptions: {
      // A failed *check* is a normal result, not a job failure. Job failures are infrastructure
      // errors (DB down, etc.), so retry quickly a couple of times.
      attempts: 3,
      backoff: { type: "exponential", delay: 2_000 },
      removeOnComplete: { count: 2_000 },
      removeOnFail: { age: 24 * 3600 },
    },
  })
  return checks
}

export function alertQueue(): Queue<AlertJob> {
  alerts ??= new Queue<AlertJob>(QUEUE.alerts, {
    connection: createRedis(),
    defaultJobOptions: {
      attempts: 6, // ~10s, 20s, 40s, 80s, 160s: rides out short Slack/SMTP outages
      backoff: { type: "exponential", delay: 10_000 },
      removeOnComplete: { count: 2_000 },
      removeOnFail: { age: 7 * 24 * 3600 },
    },
  })
  return alerts
}

/** Job IDs make enqueueing idempotent: the same delivery is never queued twice. */
export async function enqueueDeliveries(ids: number[]) {
  if (ids.length === 0) return
  await alertQueue().addBulk(ids.map((id) => ({ name: "deliver", data: { deliveryId: id }, opts: { jobId: `delivery-${id}` } })))
}

export async function closeQueues() {
  await Promise.all([checks?.close(), alerts?.close()])
  checks = undefined
  alerts = undefined
}
