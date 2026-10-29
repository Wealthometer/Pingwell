import { Agent, fetch } from "undici"
import { assertAllowedUrl, guardedLookup } from "./ssrf.js"

export type CheckTarget = {
  url: string
  method: "GET" | "HEAD" | "POST"
  headers: Record<string, string>
  body: string | null
  expectedStatusMin: number
  expectedStatusMax: number
  keyword: string | null
  timeoutMs: number
}

export type CheckOutcome = {
  ok: boolean
  statusCode: number | null
  responseMs: number
  error: string | null
}

const MAX_REDIRECTS = 5
const MAX_BODY_BYTES = 1024 * 1024 // only read up to 1 MB when searching for a keyword
export const USER_AGENT = "Pingwell/1.0 (+https://github.com/Wealthometer/pingwell)"

const agents = new Map<boolean, Agent>()
function agentFor(allowPrivate: boolean) {
  let a = agents.get(allowPrivate)
  if (!a) {
    a = new Agent({
      connect: { lookup: guardedLookup(allowPrivate) as never, timeout: 10_000 },
      keepAliveTimeout: 4_000,
      connections: 64,
    })
    agents.set(allowPrivate, a)
  }
  return a
}

async function readUpTo(body: ReadableStream<Uint8Array> | null, limit: number): Promise<string> {
  if (!body) return ""
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (size < limit) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      size += value.byteLength
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  return Buffer.concat(chunks).toString("utf8")
}

function describe(err: unknown, timeoutMs: number): string {
  const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string; name?: string } }
  if (e?.name === "TimeoutError" || e?.name === "AbortError") return `Timed out after ${timeoutMs} ms`
  const cause = e?.cause
  if (cause && (cause.name === "BlockedTargetError" || cause.code === "EBLOCKED")) return cause.message ?? "Blocked target"
  switch (cause?.code) {
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return "DNS lookup failed"
    case "ECONNREFUSED":
      return "Connection refused"
    case "ECONNRESET":
      return "Connection reset by peer"
    case "UND_ERR_CONNECT_TIMEOUT":
      return "Connection timed out"
    case "CERT_HAS_EXPIRED":
      return "TLS certificate has expired"
    case "ERR_TLS_CERT_ALTNAME_INVALID":
      return "TLS certificate does not match the host"
    case "DEPTH_ZERO_SELF_SIGNED_CERT":
    case "SELF_SIGNED_CERT_IN_CHAIN":
      return "Self-signed TLS certificate"
  }
  if (e?.name === "BlockedTargetError") return e.message ?? "Blocked target"
  return cause?.message ?? e?.message ?? "Request failed"
}

/**
 * Performs one HTTP check. Never throws for a target problem: a down site is a result, not an error.
 * Redirects are followed manually so every hop goes through the SSRF checks.
 */
export async function runCheck(target: CheckTarget, opts: { allowPrivate: boolean }): Promise<CheckOutcome> {
  const started = performance.now()
  const signal = AbortSignal.timeout(target.timeoutMs)
  const elapsed = () => Math.round(performance.now() - started)

  try {
    let url = assertAllowedUrl(target.url, opts.allowPrivate)
    let method: string = target.method
    let body: string | undefined = target.body ?? undefined

    for (let hop = 0; ; hop++) {
      const res = await fetch(url, {
        method,
        body: method === "GET" || method === "HEAD" ? undefined : body,
        headers: { "user-agent": USER_AGENT, accept: "*/*", ...target.headers },
        redirect: "manual",
        signal,
        dispatcher: agentFor(opts.allowPrivate),
      })

      const location = res.headers.get("location")
      if (res.status >= 300 && res.status < 400 && location) {
        await res.body?.cancel().catch(() => {})
        if (hop >= MAX_REDIRECTS) return { ok: false, statusCode: res.status, responseMs: elapsed(), error: `Too many redirects (>${MAX_REDIRECTS})` }
        url = assertAllowedUrl(new URL(location, url).toString(), opts.allowPrivate)
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
          method = "GET"
          body = undefined
        }
        continue
      }

      const statusOk = res.status >= target.expectedStatusMin && res.status <= target.expectedStatusMax
      if (!statusOk) {
        await res.body?.cancel().catch(() => {})
        return {
          ok: false,
          statusCode: res.status,
          responseMs: elapsed(),
          error: `Expected status ${target.expectedStatusMin}–${target.expectedStatusMax}, got ${res.status}`,
        }
      }

      if (target.keyword && method !== "HEAD") {
        const text = await readUpTo(res.body, MAX_BODY_BYTES)
        const ms = elapsed()
        if (!text.includes(target.keyword)) {
          return { ok: false, statusCode: res.status, responseMs: ms, error: `Keyword "${target.keyword}" not found in response` }
        }
        return { ok: true, statusCode: res.status, responseMs: ms, error: null }
      }

      await res.body?.cancel().catch(() => {})
      return { ok: true, statusCode: res.status, responseMs: elapsed(), error: null }
    }
  } catch (err) {
    return { ok: false, statusCode: null, responseMs: elapsed(), error: describe(err, target.timeoutMs) }
  }
}
