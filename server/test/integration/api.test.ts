import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { closeDb, db } from "../../src/db/pool.js"
import { closeQueues } from "../../src/queues.js"
import { closeRedis } from "../../src/redis.js"
import { type App, client, makeApp, resetState } from "../helpers.js"

let app: App
beforeAll(async () => {
  await resetState()
  app = await makeApp()
})
afterAll(async () => {
  await app.close()
  await closeQueues()
  await closeRedis()
  await closeDb()
})

const monitor = { name: "Shop", url: "https://shop.example.com/", intervalSeconds: 60 }

describe("auth", () => {
  it("registers, keeps a session cookie and returns the user", async () => {
    const c = client(app)
    const user = await c.signUp("alice@example.com")
    expect(user.email).toBe("alice@example.com")
    const me = await c.get("/api/auth/me")
    expect(me.status).toBe(200)
    expect(me.body.user.email).toBe("alice@example.com")
  })

  it("sets an httpOnly, SameSite=Lax session cookie", async () => {
    const res = await app.inject({ method: "POST", url: "/api/auth/register", payload: { name: "C", email: "cookie@example.com", password: "a-long-test-password" } })
    expect(String(res.headers["set-cookie"])).toMatch(/HttpOnly/)
    expect(String(res.headers["set-cookie"])).toMatch(/SameSite=Lax/)
  })

  it("rejects duplicate emails case-insensitively", async () => {
    const c = client(app)
    await c.signUp("bob@example.com")
    const dup = await client(app).post("/api/auth/register", { name: "B", email: "BOB@example.com", password: "a-long-test-password" })
    expect(dup.status).toBe(409)
  })

  it("validates sign-up fields", async () => {
    const r = await client(app).post("/api/auth/register", { name: "", email: "nope", password: "short" })
    expect(r.status).toBe(400)
    expect(Object.keys(r.body.fields).sort()).toEqual(["email", "name", "password"])
  })

  it("uses the same message for unknown email and wrong password", async () => {
    await client(app).signUp("carol@example.com")
    const wrong = await client(app).post("/api/auth/login", { email: "carol@example.com", password: "wrong-password" })
    const unknown = await client(app).post("/api/auth/login", { email: "nobody@example.com", password: "wrong-password" })
    expect(wrong.status).toBe(401)
    expect(unknown.status).toBe(401)
    expect(wrong.body.error).toBe(unknown.body.error)
  })

  it("never stores plain passwords", async () => {
    const res = await db().query("SELECT password_hash FROM users WHERE email = 'carol@example.com'")
    expect(res.rows[0].password_hash).toMatch(/^\$argon2id\$/)
  })

  it("requires a session for private routes", async () => {
    expect((await client(app).get("/api/monitors")).status).toBe(401)
    expect((await app.inject({ url: "/api/monitors", headers: { cookie: "pw_session=forged.token.value" } })).statusCode).toBe(401)
  })
})

describe("monitors", () => {
  let c: ReturnType<typeof client>
  beforeEach(async () => {
    c = client(app)
    await c.signUp()
  })

  it("creates a monitor with sensible defaults", async () => {
    const r = await c.post("/api/monitors", monitor)
    expect(r.status).toBe(201)
    expect(r.body.monitor).toMatchObject({ name: "Shop", method: "GET", status: "pending", expectedStatusMin: 200, expectedStatusMax: 399, failureThreshold: 2, timeoutMs: 10000 })
  })

  it("returns field errors for bad input", async () => {
    const r = await c.post("/api/monitors", { name: "", url: "ftp://x", intervalSeconds: 1, expectedStatusMin: 500, expectedStatusMax: 200 })
    expect(r.status).toBe(400)
    expect(r.body.fields).toMatchObject({
      name: expect.any(String),
      url: "Only http and https URLs can be monitored",
      intervalSeconds: "Check at most every 10 seconds",
    })
  })

  it("updates fields and reschedules when the URL changes", async () => {
    const { body } = await c.post("/api/monitors", monitor)
    await db().query("UPDATE monitors SET next_check_at = now() + interval '1 hour' WHERE id = $1", [body.monitor.id])
    const r = await c.patch(`/api/monitors/${body.monitor.id}`, { url: "https://shop.example.com/v2", keyword: "Buy" })
    expect(r.status).toBe(200)
    expect(r.body.monitor).toMatchObject({ url: "https://shop.example.com/v2", keyword: "Buy" })
    expect(new Date(r.body.monitor.nextCheckAt).getTime()).toBeLessThan(Date.now() + 5_000)
  })

  it("pauses and resumes", async () => {
    const { body } = await c.post("/api/monitors", monitor)
    expect((await c.post(`/api/monitors/${body.monitor.id}/pause`)).body.monitor).toMatchObject({ paused: true, status: "paused" })
    expect((await c.post(`/api/monitors/${body.monitor.id}/check`)).status).toBe(409)
    expect((await c.post(`/api/monitors/${body.monitor.id}/resume`)).body.monitor).toMatchObject({ paused: false, status: "pending" })
  })

  it("only links alert channels the user owns", async () => {
    const other = client(app)
    await other.signUp()
    const foreign = await other.post("/api/channels", { type: "email", name: "Theirs", config: { to: "x@example.com" } })
    const r = await c.post("/api/monitors", { ...monitor, channelIds: [foreign.body.channel.id] })
    expect(r.status).toBe(400)
  })

  it("isolates users from each other's data", async () => {
    const { body } = await c.post("/api/monitors", monitor)
    const id = body.monitor.id
    const other = client(app)
    await other.signUp()
    expect((await other.get(`/api/monitors/${id}`)).status).toBe(404)
    expect((await other.patch(`/api/monitors/${id}`, { name: "pwned" })).status).toBe(404)
    expect((await other.del(`/api/monitors/${id}`)).status).toBe(404)
    expect((await other.get(`/api/monitors/${id}/stats`)).status).toBe(404)
    expect((await other.get("/api/monitors")).body.monitors).toHaveLength(0)
    expect((await c.get(`/api/monitors/${id}`)).body.monitor.name).toBe("Shop")
  })

  it("deletes a monitor and its history", async () => {
    const { body } = await c.post("/api/monitors", monitor)
    await db().query("INSERT INTO check_results (monitor_id, ok, response_ms) VALUES ($1, true, 10)", [body.monitor.id])
    expect((await c.del(`/api/monitors/${body.monitor.id}`)).status).toBe(204)
    expect((await db().query("SELECT count(*)::int n FROM check_results WHERE monitor_id = $1", [body.monitor.id])).rows[0].n).toBe(0)
  })

  it("rejects malformed ids with 400, not 500", async () => {
    expect((await c.get("/api/monitors/not-a-uuid")).status).toBe(400)
  })
})

describe("alert channels", () => {
  it("masks webhook URLs and returns the signing secret only once", async () => {
    const c = client(app)
    await c.signUp()
    const created = await c.post("/api/channels", { type: "webhook", name: "Ops", config: { url: "https://hooks.example.com/abcdef1234567890/xyz" } })
    expect(created.status).toBe(201)
    expect(created.body.secret).toMatch(/^[a-f0-9]{48}$/)
    const list = await c.get("/api/channels")
    const json = JSON.stringify(list.body)
    expect(json).not.toContain(created.body.secret)
    expect(json).not.toContain("abcdef1234567890/xyz")
  })

  it("checks that Slack channels use Slack webhook URLs", async () => {
    const c = client(app)
    await c.signUp()
    const r = await c.post("/api/channels", { type: "slack", name: "S", config: { url: "https://evil.example.com/hook" } })
    expect(r.status).toBe(400)
    expect(r.body.fields["config.url"]).toMatch(/hooks.slack.com/)
  })
})

describe("health", () => {
  it("reports liveness and readiness", async () => {
    expect((await app.inject({ url: "/health" })).json()).toEqual({ ok: true })
    expect((await app.inject({ url: "/health/ready" })).json()).toEqual({ ok: true, postgres: true, redis: true })
  })

  it("exposes Prometheus metrics", async () => {
    const res = await app.inject({ url: "/metrics" })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain("pingwell_http_requests_total")
    expect(res.body).toContain("pingwell_queue_jobs")
  })

  it("reports the system as down when no worker is running", async () => {
    const c = client(app)
    await c.signUp()
    const r = await c.get("/api/system")
    expect(r.body.verdict).toBe("down")
    expect(r.body.problems[0]).toMatch(/No workers/)
  })
})
