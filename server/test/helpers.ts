import { createServer, type IncomingMessage, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import type { FastifyInstance } from "fastify"
import { buildApp } from "../src/api/app.js"
import { db } from "../src/db/pool.js"
import { migrate } from "../src/db/migrate.js"
import { redis } from "../src/redis.js"

/** Fresh schema + empty Redis DB. */
export async function resetState() {
  await db().query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;")
  await migrate(() => {})
  await redis().flushdb()
}

export type App = Awaited<ReturnType<typeof buildApp>>

export async function makeApp(): Promise<App> {
  const app = await buildApp()
  await app.ready()
  return app
}

/** A port with nothing listening on it (for "connection refused" cases). */
export async function closedPort(): Promise<number> {
  const s = createServer()
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r))
  const port = (s.address() as AddressInfo).port
  await new Promise<void>((r) => s.close(() => r()))
  return port
}

/** Minimal cookie-jar client around fastify.inject. */
export function client(app: App | FastifyInstance) {
  let cookie = ""
  const call = async (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) => {
    const res = await app.inject({ method, url, payload: payload as object | undefined, headers: cookie ? { cookie } : {} })
    const set = res.headers["set-cookie"]
    if (set) cookie = (Array.isArray(set) ? set[0]! : set).split(";")[0]!
    return { status: res.statusCode, body: res.body ? res.json() : null, headers: res.headers }
  }
  return {
    get: (url: string) => call("GET", url),
    post: (url: string, body?: unknown) => call("POST", url, body),
    patch: (url: string, body?: unknown) => call("PATCH", url, body),
    del: (url: string) => call("DELETE", url),
    async signUp(email = `u${Math.random().toString(36).slice(2)}@example.com`) {
      const r = await call("POST", "/api/auth/register", { name: "Test User", email, password: "a-long-test-password" })
      if (r.status !== 201) throw new Error(`signUp failed: ${JSON.stringify(r.body)}`)
      return r.body.user as { id: string; email: string }
    },
  }
}

/** A controllable HTTP target and a webhook receiver for pipeline tests. */
export async function startServer(handler: (req: IncomingMessage, body: string) => { status?: number; body?: string; delayMs?: number }) {
  const server: Server = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      const r = handler(req, body)
      setTimeout(() => {
        res.statusCode = r.status ?? 200
        res.end(r.body ?? "ok")
      }, r.delayMs ?? 0)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) }
}
