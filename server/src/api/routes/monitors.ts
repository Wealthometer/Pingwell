import type { FastifyInstance } from "fastify"
import type { PoolClient } from "pg"
import { z } from "zod"
import { config } from "../../config.js"
import { db, withTransaction } from "../../db/pool.js"
import { assertAllowedUrl } from "../../monitoring/ssrf.js"
import { checkQueue } from "../../queues.js"
import { HttpError, notFound, parse, userId, uuidParam } from "../http.js"

const urlField = z
  .string()
  .trim()
  .max(2000)
  .superRefine((v, ctx) => {
    try {
      assertAllowedUrl(v, config().ALLOW_PRIVATE_TARGETS)
    } catch (err) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: (err as Error).message.replace(/^Invalid URL$/, "Enter a full URL, like https://example.com") })
    }
  })

const monitorFields = {
  name: z.string().trim().min(1, "Give the monitor a name").max(100),
  url: urlField,
  method: z.enum(["GET", "HEAD", "POST"]),
  headers: z
    .record(z.string().max(200), z.string().max(2000))
    .refine((h) => Object.keys(h).length <= 20, "At most 20 headers"),
  body: z.string().max(10_000).nullable(),
  expectedStatusMin: z.number().int().min(100).max(599),
  expectedStatusMax: z.number().int().min(100).max(599),
  keyword: z.string().max(200).nullable(),
  timeoutMs: z.number().int().min(1000).max(60_000),
  intervalSeconds: z.number().int().max(86_400),
  failureThreshold: z.number().int().min(1).max(10),
  recoveryThreshold: z.number().int().min(1).max(10),
  slowThresholdMs: z.number().int().min(1).max(60_000).nullable(),
  channelIds: z.array(z.string().uuid()).max(20),
}

const withInterval = <T extends z.ZodTypeAny>(s: T) =>
  s.superRefine((v: { intervalSeconds?: number; expectedStatusMin?: number; expectedStatusMax?: number }, ctx) => {
    const min = config().MIN_INTERVAL_SECONDS
    if (v.intervalSeconds !== undefined && v.intervalSeconds < min)
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["intervalSeconds"], message: `Check at most every ${min} seconds` })
    if (v.expectedStatusMin !== undefined && v.expectedStatusMax !== undefined && v.expectedStatusMin > v.expectedStatusMax)
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["expectedStatusMax"], message: "Must be at least the minimum status" })
  })

const CreateMonitor = withInterval(
  z.object({
    ...monitorFields,
    method: monitorFields.method.default("GET"),
    headers: monitorFields.headers.default({}),
    body: monitorFields.body.default(null),
    expectedStatusMin: monitorFields.expectedStatusMin.default(200),
    expectedStatusMax: monitorFields.expectedStatusMax.default(399),
    keyword: monitorFields.keyword.default(null),
    timeoutMs: monitorFields.timeoutMs.default(10_000),
    intervalSeconds: monitorFields.intervalSeconds.default(60),
    failureThreshold: monitorFields.failureThreshold.default(2),
    recoveryThreshold: monitorFields.recoveryThreshold.default(1),
    slowThresholdMs: monitorFields.slowThresholdMs.default(null),
    channelIds: monitorFields.channelIds.default([]),
  }),
)
const UpdateMonitor = withInterval(z.object(monitorFields).partial())

const Range = z.object({ range: z.enum(["24h", "7d", "30d", "90d"]).default("24h") })
const RANGES = {
  "24h": { span: "24 hours", bucket: "30 minutes" },
  "7d": { span: "7 days", bucket: "4 hours" },
  "30d": { span: "30 days", bucket: "1 day" },
  "90d": { span: "90 days", bucket: "1 day" },
} as const

const COLUMNS = `
  m.id, m.name, m.url, m.method, m.headers, m.body,
  m.expected_status_min AS "expectedStatusMin", m.expected_status_max AS "expectedStatusMax",
  m.keyword, m.timeout_ms AS "timeoutMs", m.interval_seconds AS "intervalSeconds",
  m.failure_threshold AS "failureThreshold", m.recovery_threshold AS "recoveryThreshold",
  m.slow_threshold_ms AS "slowThresholdMs", m.status, m.paused,
  m.last_checked_at AS "lastCheckedAt", m.last_response_ms AS "lastResponseMs", m.last_error AS "lastError",
  m.next_check_at AS "nextCheckAt", m.created_at AS "createdAt"`

async function assertChannelsOwned(client: PoolClient, uid: string, ids: string[]) {
  if (ids.length === 0) return
  const res = await client.query("SELECT count(*)::int AS n FROM alert_channels WHERE user_id = $1 AND id = ANY($2::uuid[])", [uid, ids])
  if (res.rows[0].n !== new Set(ids).size) throw new HttpError(400, "Some alert channels don't exist", { fields: { channelIds: "Unknown channel" } })
}

async function setChannels(client: PoolClient, monitorId: string, ids: string[]) {
  await client.query("DELETE FROM monitor_channels WHERE monitor_id = $1", [monitorId])
  if (ids.length) {
    await client.query("INSERT INTO monitor_channels (monitor_id, channel_id) SELECT $1, unnest($2::uuid[]) ON CONFLICT DO NOTHING", [monitorId, ids])
  }
}

async function loadMonitor(uid: string, id: string) {
  const res = await db().query(
    `SELECT ${COLUMNS},
            COALESCE((SELECT array_agg(channel_id) FROM monitor_channels WHERE monitor_id = m.id), '{}') AS "channelIds",
            (SELECT row_to_json(i) FROM (SELECT id, started_at AS "startedAt", cause, acknowledged_at AS "acknowledgedAt"
               FROM incidents WHERE monitor_id = m.id AND resolved_at IS NULL) i) AS "openIncident"
       FROM monitors m WHERE m.id = $1 AND m.user_id = $2`,
    [id, uid],
  )
  if (!res.rows[0]) throw notFound("Monitor")
  return res.rows[0]
}

export async function monitorRoutes(app: FastifyInstance) {
  app.addHook("onRequest", app.authenticate)

  app.get("/", async (req) => {
    const res = await db().query(
      `SELECT ${COLUMNS},
              s.checks, s.up_checks AS "upChecks",
              CASE WHEN s.checks > 0 THEN round(100.0 * s.up_checks / s.checks, 3) END AS "uptime24h",
              COALESCE(spark.points, '[]') AS sparkline
         FROM monitors m
         LEFT JOIN LATERAL (
           SELECT count(*)::int AS checks, count(*) FILTER (WHERE ok)::int AS up_checks
             FROM check_results WHERE monitor_id = m.id AND checked_at > now() - interval '24 hours'
         ) s ON true
         LEFT JOIN LATERAL (
           SELECT json_agg(json_build_object('ok', ok, 'ms', response_ms) ORDER BY checked_at) AS points
             FROM (SELECT ok, response_ms, checked_at FROM check_results WHERE monitor_id = m.id ORDER BY checked_at DESC LIMIT 40) r
         ) spark ON true
        WHERE m.user_id = $1
        ORDER BY (m.status = 'down') DESC, m.name`,
      [userId(req)],
    )
    return { monitors: res.rows }
  })

  app.post("/", async (req, reply) => {
    const uid = userId(req)
    const input = parse(CreateMonitor, req.body)
    const monitor = await withTransaction(async (client) => {
      const count = await client.query("SELECT count(*)::int AS n FROM monitors WHERE user_id = $1", [uid])
      if (count.rows[0].n >= config().MAX_MONITORS_PER_USER)
        throw new HttpError(403, `You've reached the limit of ${config().MAX_MONITORS_PER_USER} monitors`)
      await assertChannelsOwned(client, uid, input.channelIds)
      const res = await client.query<{ id: string }>(
        `INSERT INTO monitors (user_id, name, url, method, headers, body, expected_status_min, expected_status_max, keyword,
                               timeout_ms, interval_seconds, failure_threshold, recovery_threshold, slow_threshold_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id`,
        [uid, input.name, input.url, input.method, input.headers, input.body, input.expectedStatusMin, input.expectedStatusMax,
         input.keyword || null, input.timeoutMs, input.intervalSeconds, input.failureThreshold, input.recoveryThreshold, input.slowThresholdMs],
      )
      const id = res.rows[0]!.id
      await setChannels(client, id, input.channelIds)
      return id
    })
    return reply.code(201).send({ monitor: await loadMonitor(uid, monitor) })
  })

  app.get("/:id", async (req) => {
    const { id } = parse(uuidParam, req.params)
    return { monitor: await loadMonitor(userId(req), id) }
  })

  app.patch("/:id", async (req) => {
    const uid = userId(req)
    const { id } = parse(uuidParam, req.params)
    const input = parse(UpdateMonitor, req.body)
    const current = await loadMonitor(uid, id)
    const min = input.expectedStatusMin ?? current.expectedStatusMin
    const max = input.expectedStatusMax ?? current.expectedStatusMax
    if (min > max) throw new HttpError(400, "Some fields are invalid", { fields: { expectedStatusMax: "Must be at least the minimum status" } })

    const map: Record<string, string> = {
      name: "name", url: "url", method: "method", headers: "headers", body: "body",
      expectedStatusMin: "expected_status_min", expectedStatusMax: "expected_status_max", keyword: "keyword",
      timeoutMs: "timeout_ms", intervalSeconds: "interval_seconds", failureThreshold: "failure_threshold",
      recoveryThreshold: "recovery_threshold", slowThresholdMs: "slow_threshold_ms",
    }
    await withTransaction(async (client) => {
      const sets: string[] = []
      const values: unknown[] = [id, uid]
      for (const [key, col] of Object.entries(map)) {
        const v = (input as Record<string, unknown>)[key]
        if (v === undefined) continue
        values.push(key === "keyword" && v === "" ? null : v)
        sets.push(`${col} = $${values.length}`)
      }
      // Changing what or how often we check should take effect now, not at the old next slot.
      if (input.url !== undefined || input.intervalSeconds !== undefined || input.method !== undefined) sets.push("next_check_at = now()")
      if (sets.length) await client.query(`UPDATE monitors SET ${sets.join(", ")}, updated_at = now() WHERE id = $1 AND user_id = $2`, values)
      if (input.channelIds) {
        await assertChannelsOwned(client, uid, input.channelIds)
        await setChannels(client, id, input.channelIds)
      }
    })
    return { monitor: await loadMonitor(uid, id) }
  })

  app.delete("/:id", async (req, reply) => {
    const { id } = parse(uuidParam, req.params)
    const res = await db().query("DELETE FROM monitors WHERE id = $1 AND user_id = $2", [id, userId(req)])
    if (!res.rowCount) throw notFound("Monitor")
    return reply.code(204).send()
  })

  app.post("/:id/pause", async (req) => {
    const { id } = parse(uuidParam, req.params)
    const res = await db().query("UPDATE monitors SET paused = true, status = 'paused', updated_at = now() WHERE id = $1 AND user_id = $2", [id, userId(req)])
    if (!res.rowCount) throw notFound("Monitor")
    return { monitor: await loadMonitor(userId(req), id) }
  })

  app.post("/:id/resume", async (req) => {
    const { id } = parse(uuidParam, req.params)
    const res = await db().query(
      `UPDATE monitors SET paused = false, next_check_at = now(), consecutive_failures = 0, consecutive_successes = 0,
              status = CASE WHEN EXISTS (SELECT 1 FROM incidents WHERE monitor_id = $1 AND resolved_at IS NULL) THEN 'down'::monitor_status ELSE 'pending'::monitor_status END,
              updated_at = now()
        WHERE id = $1 AND user_id = $2`,
      [id, userId(req)],
    )
    if (!res.rowCount) throw notFound("Monitor")
    return { monitor: await loadMonitor(userId(req), id) }
  })

  app.post("/:id/check", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const { id } = parse(uuidParam, req.params)
    const m = await loadMonitor(userId(req), id)
    if (m.paused) throw new HttpError(409, "Resume the monitor before running a check")
    await checkQueue().add("check", { monitorId: id, reason: "manual" }, { jobId: `manual-${id}-${Date.now()}`, priority: 1 })
    return reply.code(202).send({ queued: true })
  })

  app.get("/:id/stats", async (req) => {
    const uid = userId(req)
    const { id } = parse(uuidParam, req.params)
    const { range } = parse(Range, req.query)
    await loadMonitor(uid, id)
    const r = RANGES[range]

    const summary = await db().query(
      `SELECT count(*)::int AS checks,
              count(*) FILTER (WHERE NOT ok)::int AS failures,
              CASE WHEN count(*) > 0 THEN round(100.0 * count(*) FILTER (WHERE ok) / count(*), 3) END AS "uptimePct",
              round(avg(response_ms) FILTER (WHERE ok))::int AS "avgMs",
              round(percentile_cont(0.95) WITHIN GROUP (ORDER BY response_ms) FILTER (WHERE ok))::int AS "p95Ms"
         FROM check_results WHERE monitor_id = $1 AND checked_at > now() - $2::interval`,
      [id, r.span],
    )
    const series = await db().query(
      `WITH buckets AS (
         SELECT generate_series(date_bin($3::interval, now() - $2::interval, 'epoch'), now(), $3::interval) AS t
       )
       SELECT b.t, count(c.id)::int AS checks,
              round(avg(c.response_ms) FILTER (WHERE c.ok))::int AS "avgMs",
              CASE WHEN count(c.id) > 0 THEN round(100.0 * count(*) FILTER (WHERE c.ok) / count(c.id), 2) END AS "upPct"
         FROM buckets b
         LEFT JOIN check_results c ON c.monitor_id = $1 AND c.checked_at >= b.t AND c.checked_at < b.t + $3::interval
        GROUP BY b.t ORDER BY b.t`,
      [id, r.span, r.bucket],
    )
    const incidents = await db().query(
      `SELECT count(*)::int AS count,
              COALESCE(sum(extract(epoch FROM COALESCE(resolved_at, now()) - GREATEST(started_at, now() - $2::interval))), 0)::int AS "downtimeSeconds"
         FROM incidents WHERE monitor_id = $1 AND COALESCE(resolved_at, now()) > now() - $2::interval`,
      [id, r.span],
    )
    return { range, ...summary.rows[0], incidents: incidents.rows[0], series: series.rows }
  })

  app.get("/:id/results", async (req) => {
    const uid = userId(req)
    const { id } = parse(uuidParam, req.params)
    const { limit } = parse(z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }), req.query)
    await loadMonitor(uid, id)
    const res = await db().query(
      `SELECT id, checked_at AS "checkedAt", ok, status_code AS "statusCode", response_ms AS "responseMs", error
         FROM check_results WHERE monitor_id = $1 ORDER BY checked_at DESC LIMIT $2`,
      [id, limit],
    )
    return { results: res.rows }
  })

  app.get("/:id/incidents", async (req) => {
    const uid = userId(req)
    const { id } = parse(uuidParam, req.params)
    await loadMonitor(uid, id)
    const res = await db().query(
      `SELECT id, started_at AS "startedAt", resolved_at AS "resolvedAt", cause, acknowledged_at AS "acknowledgedAt"
         FROM incidents WHERE monitor_id = $1 ORDER BY started_at DESC LIMIT 50`,
      [id],
    )
    return { incidents: res.rows }
  })
}
