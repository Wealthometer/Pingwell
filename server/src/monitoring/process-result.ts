import type { PoolClient } from "pg"
import { withTransaction } from "../db/pool.js"
import type { CheckOutcome } from "./checker.js"
import { evaluate, formatDuration, type MonitorStatus } from "./incident-engine.js"

export type ProcessedResult = {
  skipped: boolean
  status?: MonitorStatus
  action?: "none" | "open_incident" | "resolve_incident"
  incidentId?: string
  deliveryIds: number[]
}

async function createDeliveries(client: PoolClient, monitorId: string, incidentId: string, kind: "opened" | "resolved") {
  const res = await client.query<{ id: number }>(
    `INSERT INTO alert_deliveries (incident_id, channel_id, kind)
     SELECT $2, c.id, $3
       FROM monitor_channels mc
       JOIN alert_channels c ON c.id = mc.channel_id AND c.enabled
      WHERE mc.monitor_id = $1
     ON CONFLICT (incident_id, channel_id, kind) DO NOTHING
     RETURNING id`,
    [monitorId, incidentId, kind],
  )
  return res.rows.map((r) => r.id)
}

/**
 * Records a check result and applies the incident rules atomically.
 *
 * The monitor row is locked FOR UPDATE, so two workers finishing checks for the same monitor at
 * once are serialized, and the partial unique index on incidents guarantees a single open
 * incident. Alert deliveries are written in the same transaction (transactional outbox) and only
 * enqueued after commit; a sweeper re-enqueues any that were committed but never queued.
 */
export async function processResult(monitorId: string, outcome: CheckOutcome, checkedAt = new Date()): Promise<ProcessedResult> {
  return withTransaction(async (client) => {
    const m = await client.query<{
      status: MonitorStatus
      paused: boolean
      consecutive_failures: number
      consecutive_successes: number
      failure_threshold: number
      recovery_threshold: number
    }>(
      `SELECT status, paused, consecutive_failures, consecutive_successes, failure_threshold, recovery_threshold
         FROM monitors WHERE id = $1 FOR UPDATE`,
      [monitorId],
    )
    const monitor = m.rows[0]
    // Deleted or paused while the check was in flight: drop the result.
    if (!monitor || monitor.paused) return { skipped: true, deliveryIds: [] }

    const open = await client.query<{ id: string; started_at: Date }>(
      "SELECT id, started_at FROM incidents WHERE monitor_id = $1 AND resolved_at IS NULL",
      [monitorId],
    )
    const openIncident = open.rows[0]

    await client.query(
      "INSERT INTO check_results (monitor_id, checked_at, ok, status_code, response_ms, error) VALUES ($1, $2, $3, $4, $5, $6)",
      [monitorId, checkedAt, outcome.ok, outcome.statusCode, outcome.responseMs, outcome.error],
    )

    const t = evaluate(
      {
        status: monitor.status,
        consecutiveFailures: monitor.consecutive_failures,
        consecutiveSuccesses: monitor.consecutive_successes,
        failureThreshold: monitor.failure_threshold,
        recoveryThreshold: monitor.recovery_threshold,
        hasOpenIncident: Boolean(openIncident),
      },
      outcome.ok,
    )

    await client.query(
      `UPDATE monitors
          SET status = $2, consecutive_failures = $3, consecutive_successes = $4,
              last_checked_at = $5, last_response_ms = $6, last_error = $7, updated_at = now()
        WHERE id = $1`,
      [monitorId, t.status, t.consecutiveFailures, t.consecutiveSuccesses, checkedAt, outcome.responseMs, outcome.error],
    )

    let incidentId = openIncident?.id
    let deliveryIds: number[] = []

    if (t.action === "open_incident") {
      const cause = outcome.error ?? `Unexpected status ${outcome.statusCode}`
      const inc = await client.query<{ id: string }>(
        "INSERT INTO incidents (monitor_id, started_at, cause) VALUES ($1, $2, $3) RETURNING id",
        [monitorId, checkedAt, cause],
      )
      incidentId = inc.rows[0]!.id
      await client.query("INSERT INTO incident_events (incident_id, at, type, message) VALUES ($1, $2, 'opened', $3)", [
        incidentId,
        checkedAt,
        `Down after ${t.consecutiveFailures} consecutive failed check${t.consecutiveFailures === 1 ? "" : "s"}: ${cause}`,
      ])
      deliveryIds = await createDeliveries(client, monitorId, incidentId, "opened")
    } else if (t.action === "resolve_incident" && openIncident) {
      await client.query("UPDATE incidents SET resolved_at = $2 WHERE id = $1", [openIncident.id, checkedAt])
      const duration = formatDuration(checkedAt.getTime() - openIncident.started_at.getTime())
      await client.query("INSERT INTO incident_events (incident_id, at, type, message) VALUES ($1, $2, 'resolved', $3)", [
        openIncident.id,
        checkedAt,
        `Recovered after ${duration} (HTTP ${outcome.statusCode}, ${outcome.responseMs} ms)`,
      ])
      deliveryIds = await createDeliveries(client, monitorId, openIncident.id, "resolved")
    }

    return { skipped: false, status: t.status, action: t.action, incidentId, deliveryIds }
  })
}
