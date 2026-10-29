import { config } from "../config.js"
import { db } from "../db/pool.js"
import { formatDuration } from "../monitoring/incident-engine.js"
import { send, type AlertMessage, type ChannelConfig } from "./senders.js"

type DeliveryRow = {
  id: number
  status: "pending" | "sent" | "failed"
  kind: "opened" | "resolved"
  incident_id: string
  cause: string
  started_at: Date
  resolved_at: Date | null
  monitor_name: string
  monitor_url: string
  channel_type: ChannelConfig["type"]
  channel_name: string
  channel_config: ChannelConfig["config"]
  channel_enabled: boolean
}

export function buildMessage(row: Pick<DeliveryRow, "kind" | "incident_id" | "cause" | "started_at" | "resolved_at" | "monitor_name" | "monitor_url">): AlertMessage {
  const incidentUrl = `${config().PUBLIC_APP_URL}/incidents/${row.incident_id}`
  if (row.kind === "opened") {
    return {
      kind: "opened",
      monitorName: row.monitor_name,
      monitorUrl: row.monitor_url,
      title: `${row.monitor_name} is down`,
      detail: row.cause,
      incidentUrl,
      at: row.started_at,
    }
  }
  const resolvedAt = row.resolved_at ?? new Date()
  return {
    kind: "resolved",
    monitorName: row.monitor_name,
    monitorUrl: row.monitor_url,
    title: `${row.monitor_name} is back up`,
    detail: `Down for ${formatDuration(resolvedAt.getTime() - row.started_at.getTime())}. Cause: ${row.cause}`,
    incidentUrl,
    at: resolvedAt,
  }
}

/**
 * Delivers one alert. Safe to call any number of times for the same delivery: once marked sent it
 * becomes a no-op, so BullMQ retries or sweeper re-enqueues never send duplicates after success.
 */
export async function deliver(deliveryId: number): Promise<"sent" | "skipped"> {
  const res = await db().query<DeliveryRow>(
    `SELECT d.id, d.status, d.kind, d.incident_id, i.cause, i.started_at, i.resolved_at,
            m.name AS monitor_name, m.url AS monitor_url,
            c.type AS channel_type, c.name AS channel_name, c.config AS channel_config, c.enabled AS channel_enabled
       FROM alert_deliveries d
       JOIN incidents i ON i.id = d.incident_id
       JOIN monitors m ON m.id = i.monitor_id
       JOIN alert_channels c ON c.id = d.channel_id
      WHERE d.id = $1`,
    [deliveryId],
  )
  const row = res.rows[0]
  if (!row || row.status !== "pending" || !row.channel_enabled) return "skipped"

  await db().query("UPDATE alert_deliveries SET attempts = attempts + 1 WHERE id = $1", [deliveryId])
  try {
    await send({ type: row.channel_type, config: row.channel_config } as ChannelConfig, buildMessage(row))
  } catch (err) {
    await db().query("UPDATE alert_deliveries SET last_error = $2 WHERE id = $1", [deliveryId, (err as Error).message])
    throw err
  }

  const updated = await db().query(
    "UPDATE alert_deliveries SET status = 'sent', sent_at = now(), last_error = NULL WHERE id = $1 AND status = 'pending'",
    [deliveryId],
  )
  if (updated.rowCount) {
    await db().query("INSERT INTO incident_events (incident_id, type, message) VALUES ($1, 'alert_sent', $2)", [
      row.incident_id,
      `${row.kind === "opened" ? "Down" : "Recovery"} alert sent to ${row.channel_name} (${row.channel_type})`,
    ])
  }
  return "sent"
}

/** Called when BullMQ has used up all retries. */
export async function markDeliveryFailed(deliveryId: number, error: string) {
  const res = await db().query<{ incident_id: string; name: string; type: string; kind: string }>(
    `UPDATE alert_deliveries d SET status = 'failed', last_error = $2
       FROM alert_channels c
      WHERE d.id = $1 AND d.status = 'pending' AND c.id = d.channel_id
     RETURNING d.incident_id, c.name, c.type, d.kind`,
    [deliveryId, error],
  )
  const row = res.rows[0]
  if (row) {
    await db().query("INSERT INTO incident_events (incident_id, type, message) VALUES ($1, 'alert_failed', $2)", [
      row.incident_id,
      `Could not deliver ${row.kind === "opened" ? "down" : "recovery"} alert to ${row.name} (${row.type}) after retries: ${error}`,
    ])
  }
}

/** Outbox sweeper: pending deliveries that were committed but may never have been queued. */
export async function findStrandedDeliveries(olderThanSeconds = 60): Promise<number[]> {
  const res = await db().query<{ id: number }>(
    "SELECT id FROM alert_deliveries WHERE status = 'pending' AND created_at < now() - make_interval(secs => $1) LIMIT 500",
    [olderThanSeconds],
  )
  return res.rows.map((r) => r.id)
}
