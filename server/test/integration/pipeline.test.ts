import { createHmac } from "node:crypto"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { deliver, findStrandedDeliveries, markDeliveryFailed } from "../../src/alerts/deliver.js"
import { closeDb, db } from "../../src/db/pool.js"
import { processResult } from "../../src/monitoring/process-result.js"
import { runMonitorCheck } from "../../src/monitoring/run-monitor-check.js"
import { claimDueMonitors } from "../../src/monitoring/scheduler.js"
import { closeQueues } from "../../src/queues.js"
import { closeRedis } from "../../src/redis.js"
import { type App, client, makeApp, resetState, startServer } from "../helpers.js"

let app: App
let target: Awaited<ReturnType<typeof startServer>>
let hook: Awaited<ReturnType<typeof startServer>>
let targetStatus = 200
let hookStatus = 200
const received: { body: string; signature: string }[] = []

beforeAll(async () => {
  await resetState()
  app = await makeApp()
  target = await startServer(() => ({ status: targetStatus, body: "store is open" }))
  hook = await startServer((req, body) => {
    received.push({ body, signature: String(req.headers["x-pingwell-signature"]) })
    return { status: hookStatus }
  })
})
afterAll(async () => {
  await Promise.all([target.close(), hook.close(), app.close()])
  await closeQueues()
  await closeRedis()
  await closeDb()
})

const fail = { ok: false, statusCode: 503, responseMs: 12, error: "Expected status 200–399, got 503" }
const pass = { ok: true, statusCode: 200, responseMs: 30, error: null }

async function setup(opts: { failureThreshold?: number; recoveryThreshold?: number } = {}) {
  const c = client(app)
  await c.signUp()
  const ch = await c.post("/api/channels", { type: "webhook", name: "Hook", config: { url: `${hook.url}/in` } })
  const m = await c.post("/api/monitors", {
    name: "Store", url: `${target.url}/`, intervalSeconds: 60, channelIds: [ch.body.channel.id],
    failureThreshold: opts.failureThreshold ?? 2, recoveryThreshold: opts.recoveryThreshold ?? 1,
  })
  return { c, monitorId: m.body.monitor.id as string, secret: ch.body.secret as string }
}

const openIncidents = async (monitorId: string) =>
  (await db().query("SELECT id FROM incidents WHERE monitor_id = $1 AND resolved_at IS NULL", [monitorId])).rows

beforeEach(() => {
  received.length = 0
  targetStatus = 200
  hookStatus = 200
})

describe("check → incident → alert pipeline", () => {
  it("runs a real check against the target and records it", async () => {
    const { monitorId } = await setup()
    const r = await runMonitorCheck(monitorId)
    expect(r).toMatchObject({ skipped: false, status: "up", action: "none" })
    const rows = await db().query("SELECT ok, status_code FROM check_results WHERE monitor_id = $1", [monitorId])
    expect(rows.rows).toEqual([{ ok: true, status_code: 200 }])
  })

  it("opens an incident after the threshold, alerts with a valid signature, then resolves", async () => {
    const { monitorId, secret } = await setup()
    targetStatus = 503
    expect((await runMonitorCheck(monitorId)).action).toBe("none")
    const opened = await runMonitorCheck(monitorId)
    expect(opened.action).toBe("open_incident")
    expect(opened.deliveryIds).toHaveLength(1)

    expect(await deliver(opened.deliveryIds[0]!)).toBe("sent")
    expect(received).toHaveLength(1)
    const [{ body, signature }] = received as [{ body: string; signature: string }]
    const [, ts, mac] = signature.match(/^t=(\d+),v1=([a-f0-9]{64})$/) ?? []
    expect(mac).toBe(createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex"))
    expect(JSON.parse(body)).toMatchObject({ event: "incident.opened", title: "Store is down", incident_url: `http://pingwell.test/incidents/${opened.incidentId}` })

    targetStatus = 200
    const resolved = await runMonitorCheck(monitorId)
    expect(resolved.action).toBe("resolve_incident")
    await deliver(resolved.deliveryIds[0]!)
    expect(JSON.parse(received[1]!.body).event).toBe("incident.resolved")

    const events = await db().query("SELECT type FROM incident_events WHERE incident_id = $1 ORDER BY at, id", [opened.incidentId])
    expect(events.rows.map((e) => e.type)).toEqual(["opened", "alert_sent", "resolved", "alert_sent"])
  })

  it("never opens two incidents when results for one monitor race", async () => {
    const { monitorId } = await setup({ failureThreshold: 1 })
    await Promise.all(Array.from({ length: 8 }, () => processResult(monitorId, fail)))
    expect(await openIncidents(monitorId)).toHaveLength(1)
    const m = await db().query("SELECT consecutive_failures FROM monitors WHERE id = $1", [monitorId])
    expect(m.rows[0].consecutive_failures).toBe(8)
  })

  it("delivers each alert at most once, even when the job runs again", async () => {
    const { monitorId } = await setup({ failureThreshold: 1 })
    const r = await processResult(monitorId, fail)
    const id = r.deliveryIds[0]!
    expect(await deliver(id)).toBe("sent")
    expect(await deliver(id)).toBe("skipped")
    expect(await deliver(id)).toBe("skipped")
    expect(received).toHaveLength(1)
  })

  it("keeps failed deliveries retryable and records a final failure on the timeline", async () => {
    const { monitorId } = await setup({ failureThreshold: 1 })
    hookStatus = 500
    const r = await processResult(monitorId, fail)
    const id = r.deliveryIds[0]!
    await expect(deliver(id)).rejects.toThrow(/HTTP 500/)
    const row = await db().query("SELECT status, attempts, last_error FROM alert_deliveries WHERE id = $1", [id])
    expect(row.rows[0]).toMatchObject({ status: "pending", attempts: 1, last_error: expect.stringContaining("HTTP 500") })

    await markDeliveryFailed(id, "HTTP 500")
    const ev = await db().query("SELECT message FROM incident_events WHERE incident_id = $1 AND type = 'alert_failed'", [r.incidentId])
    expect(ev.rows[0].message).toMatch(/Could not deliver down alert to Hook/)
  })

  it("finds deliveries that were committed but never queued (outbox sweep)", async () => {
    const { monitorId } = await setup({ failureThreshold: 1 })
    const r = await processResult(monitorId, fail)
    await db().query("UPDATE alert_deliveries SET created_at = now() - interval '5 minutes' WHERE id = $1", [r.deliveryIds[0]])
    expect(await findStrandedDeliveries(60)).toContain(r.deliveryIds[0])
  })

  it("does not alert disabled channels", async () => {
    const { c, monitorId } = await setup({ failureThreshold: 1 })
    const channels = await c.get("/api/channels")
    await c.patch(`/api/channels/${channels.body.channels[0].id}`, { enabled: false })
    const r = await processResult(monitorId, fail)
    expect(r.action).toBe("open_incident")
    expect(r.deliveryIds).toHaveLength(0)
  })

  it("drops results for monitors paused while a check was in flight", async () => {
    const { c, monitorId } = await setup()
    await c.post(`/api/monitors/${monitorId}/pause`)
    expect((await processResult(monitorId, fail)).skipped).toBe(true)
  })

  it("respects the recovery threshold", async () => {
    const { monitorId } = await setup({ failureThreshold: 1, recoveryThreshold: 2 })
    await processResult(monitorId, fail)
    expect((await processResult(monitorId, pass)).action).toBe("none")
    expect((await processResult(monitorId, pass)).action).toBe("resolve_incident")
  })
})

describe("scheduler", () => {
  it("never hands the same due monitor to two schedulers", async () => {
    for (let i = 0; i < 3; i++) await setup()
    await db().query("UPDATE monitors SET next_check_at = now() - interval '1 second'")
    const due = (await db().query("SELECT count(*)::int n FROM monitors WHERE NOT paused")).rows[0].n
    const [a, b, c] = await Promise.all([claimDueMonitors(500), claimDueMonitors(500), claimDueMonitors(500)])
    const ids = [...a!, ...b!, ...c!].map((x) => x.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.length).toBe(due)
    expect(await claimDueMonitors(500)).toHaveLength(0) // all pushed into the future
  })

  it("skips paused monitors and does not schedule a catch-up storm after downtime", async () => {
    const { c, monitorId } = await setup()
    const { monitorId: other } = await setup()
    await c.post(`/api/monitors/${monitorId}/pause`)
    await db().query("UPDATE monitors SET next_check_at = now() - interval '6 hours'")
    const claimed = (await claimDueMonitors(500)).map((x) => x.id)
    expect(claimed).not.toContain(monitorId)
    expect(claimed).toContain(other)
    const next = await db().query("SELECT next_check_at FROM monitors WHERE id = $1", [other])
    expect(new Date(next.rows[0].next_check_at).getTime()).toBeGreaterThan(Date.now())
  })
})

describe("public status page", () => {
  it("shows status and history without leaking URLs or error details", async () => {
    const { c, monitorId } = await setup({ failureThreshold: 1 })
    await processResult(monitorId, { ...fail, error: "secret-internal-host:5432 refused" })
    const page = await c.post("/api/status-pages", { slug: "acme", title: "Acme", monitors: [{ monitorId, displayName: "Store" }] })
    expect(page.status).toBe(201)

    const pub = await app.inject({ url: "/api/public/status/acme" })
    expect(pub.statusCode).toBe(200)
    const body = pub.json()
    expect(body).toMatchObject({ title: "Acme", overall: "major_outage", monitors: [{ name: "Store", status: "down" }] })
    expect(body.monitors[0].history).toHaveLength(90)
    expect(pub.body).not.toContain(target.url)
    expect(pub.body).not.toContain("secret-internal-host")
    expect(pub.headers["cache-control"]).toMatch(/max-age=30/)
  })

  it("hides unpublished pages and rejects taken slugs", async () => {
    const { c } = await setup()
    await c.post("/api/status-pages", { slug: "hidden-one", title: "Hidden", published: false })
    expect((await app.inject({ url: "/api/public/status/hidden-one" })).statusCode).toBe(404)
    expect((await c.post("/api/status-pages", { slug: "hidden-one", title: "Dup" })).status).toBe(409)
  })
})
