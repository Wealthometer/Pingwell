import { config } from "../config.js"
import { db } from "../db/pool.js"
import { checkDuration, checksTotal, incidentsTotal } from "../system/metrics.js"
import { runCheck, type CheckTarget } from "./checker.js"
import { processResult, type ProcessedResult } from "./process-result.js"

type MonitorRow = {
  url: string
  method: CheckTarget["method"]
  headers: Record<string, string>
  body: string | null
  expected_status_min: number
  expected_status_max: number
  keyword: string | null
  timeout_ms: number
  paused: boolean
}

/** Loads a monitor, performs the HTTP check outside any transaction, then records the result. */
export async function runMonitorCheck(monitorId: string): Promise<ProcessedResult> {
  const res = await db().query<MonitorRow>(
    `SELECT url, method, headers, body, expected_status_min, expected_status_max, keyword, timeout_ms, paused
       FROM monitors WHERE id = $1`,
    [monitorId],
  )
  const m = res.rows[0]
  if (!m || m.paused) return { skipped: true, deliveryIds: [] }

  const outcome = await runCheck(
    {
      url: m.url,
      method: m.method,
      headers: m.headers,
      body: m.body,
      expectedStatusMin: m.expected_status_min,
      expectedStatusMax: m.expected_status_max,
      keyword: m.keyword,
      timeoutMs: m.timeout_ms,
    },
    { allowPrivate: config().ALLOW_PRIVATE_TARGETS },
  )

  checksTotal.inc({ result: outcome.ok ? "up" : "down" })
  checkDuration.observe(outcome.responseMs / 1000)

  const processed = await processResult(monitorId, outcome)
  if (processed.action === "open_incident") incidentsTotal.inc({ action: "opened" })
  if (processed.action === "resolve_incident") incidentsTotal.inc({ action: "resolved" })
  return processed
}
