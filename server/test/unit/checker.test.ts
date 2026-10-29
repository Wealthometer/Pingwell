import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { runCheck, type CheckTarget } from "../../src/monitoring/checker.js"
import { closedPort, startServer } from "../helpers.js"

let server: Awaited<ReturnType<typeof startServer>>
const seen: { path: string; method: string; headers: Record<string, unknown>; body: string }[] = []

beforeAll(async () => {
  server = await startServer((req, body) => {
    seen.push({ path: req.url ?? "", method: req.method ?? "", headers: req.headers, body })
    switch (req.url) {
      case "/ok": return { body: "<h1>Welcome to the shop</h1>" }
      case "/500": return { status: 500, body: "boom" }
      case "/slow": return { delayMs: 1500 }
      case "/teapot": return { status: 418 }
      default: return { status: 404 }
    }
  })
})
afterAll(() => server.close())

const target = (path: string, extra: Partial<CheckTarget> = {}): CheckTarget => ({
  url: server.url + path, method: "GET", headers: {}, body: null, expectedStatusMin: 200, expectedStatusMax: 399, keyword: null, timeoutMs: 5000, ...extra,
})
const check = (t: CheckTarget, allowPrivate = true) => runCheck(t, { allowPrivate })

describe("runCheck", () => {
  it("reports success with status and timing", async () => {
    const r = await check(target("/ok"))
    expect(r).toMatchObject({ ok: true, statusCode: 200, error: null })
    expect(r.responseMs).toBeGreaterThanOrEqual(0)
  })

  it("fails on a status outside the expected range", async () => {
    expect(await check(target("/500"))).toMatchObject({ ok: false, statusCode: 500, error: "Expected status 200–399, got 500" })
  })

  it("accepts a custom status range", async () => {
    expect((await check(target("/teapot", { expectedStatusMin: 418, expectedStatusMax: 418 }))).ok).toBe(true)
  })

  it("checks for a keyword in the body", async () => {
    expect((await check(target("/ok", { keyword: "shop" }))).ok).toBe(true)
    expect(await check(target("/ok", { keyword: "Out of stock" }))).toMatchObject({ ok: false, error: 'Keyword "Out of stock" not found in response' })
  })

  it("times out slow targets", async () => {
    const r = await check(target("/slow", { timeoutMs: 1000 }))
    expect(r).toMatchObject({ ok: false, statusCode: null, error: "Timed out after 1000 ms" })
    expect(r.responseMs).toBeGreaterThanOrEqual(950)
  })

  it("explains refused connections", async () => {
    const port = await closedPort()
    expect(await check(target("/", { url: `http://127.0.0.1:${port}/` }))).toMatchObject({ ok: false, error: "Connection refused" })
  })

  it("sends method, headers and body, and identifies itself", async () => {
    await check(target("/ok", { method: "POST", headers: { authorization: "Bearer t0ken" }, body: '{"ping":1}' }))
    const req = seen.at(-1)!
    expect(req).toMatchObject({ method: "POST", body: '{"ping":1}' })
    expect(req.headers.authorization).toBe("Bearer t0ken")
    expect(String(req.headers["user-agent"])).toMatch(/^Pingwell\//)
  })

  it("refuses private targets when not allowed, without connecting", async () => {
    const before = seen.length
    expect(await check(target("/ok"), false)).toMatchObject({ ok: false, error: expect.stringMatching(/private or reserved/) })
    expect(seen.length).toBe(before)
  })
})
