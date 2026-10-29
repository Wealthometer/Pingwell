import type { FastifyInstance } from "fastify"
import { z } from "zod"
import { db, withTransaction } from "../../db/pool.js"
import { HttpError, notFound, parse, userId, uuidParam } from "../http.js"

const ListQuery = z.object({
  status: z.enum(["open", "resolved", "all"]).default("all"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})
const Note = z.object({ message: z.string().trim().min(1, "Write a note").max(2000) })

export async function incidentRoutes(app: FastifyInstance) {
  app.addHook("onRequest", app.authenticate)

  app.get("/", async (req) => {
    const { status, limit } = parse(ListQuery, req.query)
    const res = await db().query(
      `SELECT i.id, i.started_at AS "startedAt", i.resolved_at AS "resolvedAt", i.cause,
              i.acknowledged_at AS "acknowledgedAt",
              extract(epoch FROM COALESCE(i.resolved_at, now()) - i.started_at)::int AS "durationSeconds",
              json_build_object('id', m.id, 'name', m.name, 'url', m.url) AS monitor
         FROM incidents i JOIN monitors m ON m.id = i.monitor_id
        WHERE m.user_id = $1
          AND ($2 = 'all' OR ($2 = 'open' AND i.resolved_at IS NULL) OR ($2 = 'resolved' AND i.resolved_at IS NOT NULL))
        ORDER BY (i.resolved_at IS NULL) DESC, i.started_at DESC
        LIMIT $3`,
      [userId(req), status, limit],
    )
    return { incidents: res.rows }
  })

  async function load(uid: string, id: string) {
    const res = await db().query(
      `SELECT i.id, i.started_at AS "startedAt", i.resolved_at AS "resolvedAt", i.cause,
              i.acknowledged_at AS "acknowledgedAt", u.name AS "acknowledgedBy",
              extract(epoch FROM COALESCE(i.resolved_at, now()) - i.started_at)::int AS "durationSeconds",
              json_build_object('id', m.id, 'name', m.name, 'url', m.url, 'status', m.status) AS monitor
         FROM incidents i
         JOIN monitors m ON m.id = i.monitor_id
         LEFT JOIN users u ON u.id = i.acknowledged_by
        WHERE i.id = $1 AND m.user_id = $2`,
      [id, uid],
    )
    if (!res.rows[0]) throw notFound("Incident")
    return res.rows[0]
  }

  app.get("/:id", async (req) => {
    const uid = userId(req)
    const { id } = parse(uuidParam, req.params)
    const incident = await load(uid, id)
    const events = await db().query(
      `SELECT e.id, e.at, e.type, e.message, u.name AS "userName"
         FROM incident_events e LEFT JOIN users u ON u.id = e.user_id
        WHERE e.incident_id = $1 ORDER BY e.at, e.id`,
      [id],
    )
    const failures = await db().query(
      `SELECT checked_at AS "checkedAt", status_code AS "statusCode", response_ms AS "responseMs", error
         FROM check_results
        WHERE monitor_id = $1 AND NOT ok AND checked_at >= $2::timestamptz - interval '15 minutes'
          AND checked_at <= COALESCE($3::timestamptz, now())
        ORDER BY checked_at DESC LIMIT 20`,
      [incident.monitor.id, incident.startedAt, incident.resolvedAt],
    )
    return { incident, events: events.rows, failedChecks: failures.rows }
  })

  app.post("/:id/acknowledge", async (req) => {
    const uid = userId(req)
    const { id } = parse(uuidParam, req.params)
    const incident = await load(uid, id)
    if (incident.resolvedAt) throw new HttpError(409, "This incident is already resolved")
    if (!incident.acknowledgedAt) {
      await withTransaction(async (client) => {
        const res = await client.query(
          "UPDATE incidents SET acknowledged_at = now(), acknowledged_by = $2 WHERE id = $1 AND acknowledged_at IS NULL",
          [id, uid],
        )
        if (res.rowCount) {
          await client.query("INSERT INTO incident_events (incident_id, type, message, user_id) VALUES ($1, 'acknowledged', 'Acknowledged', $2)", [id, uid])
        }
      })
    }
    return { incident: await load(uid, id) }
  })

  app.post("/:id/notes", async (req, reply) => {
    const uid = userId(req)
    const { id } = parse(uuidParam, req.params)
    const { message } = parse(Note, req.body)
    await load(uid, id)
    const res = await db().query(
      `INSERT INTO incident_events (incident_id, type, message, user_id) VALUES ($1, 'note', $2, $3)
       RETURNING id, at, type, message`,
      [id, message, uid],
    )
    return reply.code(201).send({ event: res.rows[0] })
  })
}
