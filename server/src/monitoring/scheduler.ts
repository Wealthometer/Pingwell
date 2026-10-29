import { db } from "../db/pool.js"
import { checkQueue } from "../queues.js"

/**
 * Claims monitors that are due and pushes them onto the check queue.
 *
 * FOR UPDATE SKIP LOCKED lets any number of scheduler processes run at once without double-booking
 * a monitor, and next_check_at is advanced in the same statement, so a crash after the claim at
 * worst skips one check rather than flooding the queue. The job ID includes the slot timestamp,
 * so a duplicate enqueue of the same slot is ignored by BullMQ.
 */
export async function claimDueMonitors(batchSize: number): Promise<{ id: string; slot: number }[]> {
  const res = await db().query<{ id: string; slot: number }>(
    `WITH due AS (
       SELECT id, next_check_at
         FROM monitors
        WHERE NOT paused AND next_check_at <= now()
        ORDER BY next_check_at
        LIMIT $1
        FOR UPDATE SKIP LOCKED
     )
     UPDATE monitors m
        SET next_check_at = GREATEST(due.next_check_at + make_interval(secs => m.interval_seconds),
                                     now() + make_interval(secs => m.interval_seconds) * 0.5)
       FROM due
      WHERE m.id = due.id
     RETURNING m.id, floor(extract(epoch FROM due.next_check_at))::bigint AS slot`,
    [batchSize],
  )
  return res.rows
}

export async function schedulerTick(batchSize: number): Promise<number> {
  const due = await claimDueMonitors(batchSize)
  if (due.length === 0) return 0
  await checkQueue().addBulk(
    due.map((d) => ({
      name: "check",
      data: { monitorId: d.id, reason: "scheduled" as const },
      opts: { jobId: `check-${d.id}-${d.slot}` },
    })),
  )
  return due.length
}

/** Seconds the most overdue monitor has been waiting. Feeds the scheduler-lag metric and health. */
export async function schedulerLagSeconds(): Promise<number> {
  const res = await db().query<{ lag: number | null }>(
    "SELECT extract(epoch FROM now() - min(next_check_at))::float AS lag FROM monitors WHERE NOT paused AND next_check_at <= now()",
  )
  return Math.max(0, res.rows[0]?.lag ?? 0)
}
