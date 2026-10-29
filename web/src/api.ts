export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public fields: Record<string, string> = {},
  ) {
    super(message)
  }
}

/** Fetch wrapper: sends cookies, only sets JSON content-type when there is a body. */
export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const hasBody = init.body !== undefined
  let res: Response
  try {
    res = await fetch(path, {
      method: init.method ?? "GET",
      credentials: "include",
      headers: hasBody ? { "content-type": "application/json" } : undefined,
      body: hasBody ? JSON.stringify(init.body) : undefined,
    })
  } catch {
    throw new ApiError(0, "Can't reach the Pingwell server. Check your connection.")
  }
  if (res.status === 204) return undefined as T
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Request failed (${res.status})`, data.fields ?? {})
  return data as T
}

export type Status = "pending" | "up" | "down" | "paused"

export type Monitor = {
  id: string
  name: string
  url: string
  method: "GET" | "HEAD" | "POST"
  headers: Record<string, string>
  body: string | null
  expectedStatusMin: number
  expectedStatusMax: number
  keyword: string | null
  timeoutMs: number
  intervalSeconds: number
  failureThreshold: number
  recoveryThreshold: number
  slowThresholdMs: number | null
  status: Status
  paused: boolean
  lastCheckedAt: string | null
  lastResponseMs: number | null
  lastError: string | null
  nextCheckAt: string
  createdAt: string
  channelIds?: string[]
  openIncident?: { id: string; startedAt: string; cause: string; acknowledgedAt: string | null } | null
  uptime24h?: number | null
  sparkline?: { ok: boolean; ms: number | null }[]
}

export type Stats = {
  range: string
  checks: number
  failures: number
  uptimePct: number | null
  avgMs: number | null
  p95Ms: number | null
  incidents: { count: number; downtimeSeconds: number }
  series: { t: string; checks: number; avgMs: number | null; upPct: number | null }[]
}

export type CheckResult = { id: number; checkedAt: string; ok: boolean; statusCode: number | null; responseMs: number | null; error: string | null }

export type Incident = {
  id: string
  startedAt: string
  resolvedAt: string | null
  cause: string
  acknowledgedAt: string | null
  acknowledgedBy?: string | null
  durationSeconds: number
  monitor: { id: string; name: string; url: string; status?: Status }
}

export type IncidentEvent = { id: number; at: string; type: string; message: string; userName: string | null }

export type Channel = {
  id: string
  type: "email" | "slack" | "discord" | "webhook"
  name: string
  config: Record<string, string>
  enabled: boolean
  monitors: number
}

export type StatusPage = {
  id: string
  slug: string
  title: string
  description: string | null
  published: boolean
  monitorCount?: number
  monitors?: { monitorId: string; displayName: string | null; name: string; status: Status }[]
}

export type SystemStatus = {
  verdict: "healthy" | "degraded" | "down"
  problems: string[]
  workers: { id: string; startedAt: string; beatAt: string; checksProcessed: number; alertsProcessed: number }[]
  schedulerLastTick: string | null
  schedulerLagSeconds: number
  queues: Record<"checks" | "alerts", Record<string, number>>
}

export type User = { id: string; email: string; name: string }
