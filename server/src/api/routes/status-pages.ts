import type { FastifyInstance } from "fastify"
import type { PoolClient } from "pg"
import { z } from "zod"
import { db, withTransaction } from "../../db/pool.js"
import { HttpError, notFound, parse, userId, uuidParam } from "../http.js"

const slug = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9](?:[a-z0-9-]{1,48}[a-z0-9])$/, "3–50 characters: lowercase letters, numbers and dashes")
const PageMonitors = z
  .array(z.object({ monitorId: z.string().uuid(), displayName: z.string().trim().max(100).nullable().optional() }))
  .max(50)

const CreatePage = z.object({
  slug,
  title: z.string().trim().min(1, "Give the page a title").max(100),
  description: z.string().trim().max(500).nullable().default(null),
  published: z.boolean().default(true),
  monitors: PageMonitors.default([]),
})
const UpdatePage = CreatePage.partial()

async function setPageMonitors(client: PoolClient, uid: string, pageId: string, items: z.infer<typeof PageMonitors>) {
  const ids = items.map((i) => i.monitorId)
  if (ids.length) {
    const own = await client.query("SELECT count(*)::int AS n FROM monitors WHERE user_id = $1 AND id = ANY($2::uuid[])", [uid, ids])
    if (own.rows[0].n !== new Set(ids).size) throw new HttpError(400, "Some monitors don't exist", { fields: { monitors: "Unknown monitor" } })
  }
  await client.query("DELETE FROM status_page_monitors WHERE status_page_id = $1", [pageId])
  for (const [position, item] of items.entries()) {
    await client.query(
      "INSERT INTO status_page_monitors (status_page_id, monitor_id, position, display_name) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING",
      [pageId, item.monitorId, position, item.displayName || null],
    )
  }
}

async function loadPage(uid: string, id: string) {
  const res = await db().query(
    `SELECT p.id, p.slug, p.title, p.description, p.published, p.created_at AS "createdAt",
            COALESCE((SELECT json_agg(json_build_object('monitorId', spm.monitor_id, 'displayName', spm.display_name, 'name', m.name, 'status', m.status) ORDER BY spm.position)
                        FROM status_page_monitors spm JOIN monitors m ON m.id = spm.monitor_id WHERE spm.status_page_id = p.id), '[]') AS monitors
       FROM status_pages p WHERE p.id = $1 AND p.user_id = $2`,
    [id, uid],
  )
  if (!res.rows[0]) throw notFound("Status page")
  return res.rows[0]
}

const slugTaken = (err: unknown) => {
  if ((err as { code?: string; constraint?: string }).code === "23505") throw new HttpError(409, "That address is taken", { fields: { slug: "Already in use" } })
  throw err
}

export async function statusPageRoutes(app: FastifyInstance) {
  app.addHook("onRequest", app.authenticate)

  app.get("/", async (req) => {
    const res = await db().query(
      `SELECT p.id, p.slug, p.title, p.published,
              (SELECT count(*)::int FROM status_page_monitors WHERE status_page_id = p.id) AS "monitorCount"
         FROM status_pages p WHERE p.user_id = $1 ORDER BY p.created_at`,
      [userId(req)],
    )
    return { statusPages: res.rows }
  })

  app.post("/", async (req, reply) => {
    const uid = userId(req)
    const input = parse(CreatePage, req.body)
    const id = await withTransaction(async (client) => {
      const res = await client
        .query<{ id: string }>("INSERT INTO status_pages (user_id, slug, title, description, published) VALUES ($1, $2, $3, $4, $5) RETURNING id", [
          uid, input.slug, input.title, input.description, input.published,
        ])
        .catch(slugTaken)
      const pageId = res.rows[0]!.id
      await setPageMonitors(client, uid, pageId, input.monitors)
      return pageId
    })
    return reply.code(201).send({ statusPage: await loadPage(uid, id) })
  })

  app.get("/:id", async (req) => {
    const { id } = parse(uuidParam, req.params)
    return { statusPage: await loadPage(userId(req), id) }
  })

  app.patch("/:id", async (req) => {
    const uid = userId(req)
    const { id } = parse(uuidParam, req.params)
    const input = parse(UpdatePage, req.body)
    await loadPage(uid, id)
    await withTransaction(async (client) => {
      await client
        .query(
          `UPDATE status_pages SET slug = COALESCE($3, slug), title = COALESCE($4, title),
                  description = CASE WHEN $5::boolean THEN $6 ELSE description END, published = COALESCE($7, published)
            WHERE id = $1 AND user_id = $2`,
          [id, uid, input.slug ?? null, input.title ?? null, input.description !== undefined, input.description ?? null, input.published ?? null],
        )
        .catch(slugTaken)
      if (input.monitors) await setPageMonitors(client, uid, id, input.monitors)
    })
    return { statusPage: await loadPage(uid, id) }
  })

  app.delete("/:id", async (req, reply) => {
    const { id } = parse(uuidParam, req.params)
    const res = await db().query("DELETE FROM status_pages WHERE id = $1 AND user_id = $2", [id, userId(req)])
    if (!res.rowCount) throw notFound("Status page")
    return reply.code(204).send()
  })
}

/** Public, unauthenticated. Exposes names, status and history only: never URLs, errors or alert details. */
export async function publicRoutes(app: FastifyInstance) {
  app.get("/status/:slug", async (req, reply) => {
    const { slug: s } = parse(z.object({ slug }), req.params)
    const page = await db().query<{ id: string; title: string; description: string | null }>(
      "SELECT id, title, description FROM status_pages WHERE slug = $1 AND published",
      [s],
    )
    const p = page.rows[0]
    if (!p) throw notFound("Status page")

    const monitors = await db().query<{ id: string; name: string; status: string }>(
      `SELECT m.id, COALESCE(spm.display_name, m.name) AS name, m.status
         FROM status_page_monitors spm JOIN monitors m ON m.id = spm.monitor_id
        WHERE spm.status_page_id = $1 ORDER BY spm.position`,
      [p.id],
    )
    const ids = monitors.rows.map((m) => m.id)

    const days = await db().query<{ monitor_id: string; day: string; checks: number; up: number }>(
      `SELECT monitor_id, to_char(date_trunc('day', checked_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
              count(*)::int AS checks, count(*) FILTER (WHERE ok)::int AS up
         FROM check_results
        WHERE monitor_id = ANY($1::uuid[]) AND checked_at > now() - interval '90 days'
        GROUP BY 1, 2`,
      [ids],
    )
    const incidents = await db().query(
      `SELECT i.id, COALESCE(spm.display_name, m.name) AS "monitorName", i.started_at AS "startedAt", i.resolved_at AS "resolvedAt",
              extract(epoch FROM COALESCE(i.resolved_at, now()) - i.started_at)::int AS "durationSeconds"
         FROM incidents i
         JOIN monitors m ON m.id = i.monitor_id
         JOIN status_page_monitors spm ON spm.monitor_id = m.id AND spm.status_page_id = $2
        WHERE i.monitor_id = ANY($1::uuid[]) AND i.started_at > now() - interval '14 days'
        ORDER BY i.started_at DESC LIMIT 30`,
      [ids, p.id],
    )

    const today = new Date()
    const dayKeys = Array.from({ length: 90 }, (_, i) => {
      const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - (89 - i)))
      return d.toISOString().slice(0, 10)
    })
    const byMonitor = new Map<string, Map<string, { checks: number; up: number }>>()
    for (const r of days.rows) {
      if (!byMonitor.has(r.monitor_id)) byMonitor.set(r.monitor_id, new Map())
      byMonitor.get(r.monitor_id)!.set(r.day, { checks: r.checks, up: r.up })
    }

    const items = monitors.rows.map((m) => {
      const map = byMonitor.get(m.id) ?? new Map()
      let checks = 0
      let up = 0
      const history = dayKeys.map((day) => {
        const d = map.get(day)
        if (d) {
          checks += d.checks
          up += d.up
        }
        return { day, upPct: d ? Math.round((1000 * d.up) / d.checks) / 10 : null }
      })
      const status = m.status === "paused" ? "maintenance" : m.status === "pending" ? "up" : m.status
      return { name: m.name, status, uptime90d: checks ? Math.round((100000 * up) / checks) / 1000 : null, history }
    })

    const down = items.filter((i) => i.status === "down").length
    const overall = down === 0 ? "operational" : down === items.length ? "major_outage" : "partial_outage"

    reply.header("cache-control", "public, max-age=30")
    return { title: p.title, description: p.description, overall, monitors: items, incidents: incidents.rows, generatedAt: new Date().toISOString() }
  })
}
