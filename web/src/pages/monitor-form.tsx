import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useState, type FormEvent } from "react"
import { Link, useNavigate, useParams } from "react-router-dom"
import { api, ApiError, type Channel, type Monitor } from "../api"
import { ErrorNote, Field, Loading } from "../components/ui"

type FormState = {
  name: string
  url: string
  method: "GET" | "HEAD" | "POST"
  intervalSeconds: number
  timeoutMs: number
  expectedStatusMin: number
  expectedStatusMax: number
  keyword: string
  failureThreshold: number
  recoveryThreshold: number
  slowThresholdMs: string
  headers: string
  body: string
  channelIds: string[]
}

const DEFAULTS: FormState = {
  name: "", url: "https://", method: "GET", intervalSeconds: 60, timeoutMs: 10000, expectedStatusMin: 200, expectedStatusMax: 399,
  keyword: "", failureThreshold: 2, recoveryThreshold: 1, slowThresholdMs: "", headers: "", body: "", channelIds: [],
}
const INTERVALS = [30, 60, 120, 300, 600, 1800, 3600]

function fromMonitor(m: Monitor): FormState {
  return {
    name: m.name, url: m.url, method: m.method, intervalSeconds: m.intervalSeconds, timeoutMs: m.timeoutMs,
    expectedStatusMin: m.expectedStatusMin, expectedStatusMax: m.expectedStatusMax, keyword: m.keyword ?? "",
    failureThreshold: m.failureThreshold, recoveryThreshold: m.recoveryThreshold, slowThresholdMs: m.slowThresholdMs?.toString() ?? "",
    headers: Object.entries(m.headers).map(([k, v]) => `${k}: ${v}`).join("\n"), body: m.body ?? "", channelIds: m.channelIds ?? [],
  }
}

function parseHeaders(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split("\n")) {
    const i = line.indexOf(":")
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return out
}

export function MonitorForm() {
  const { id } = useParams()
  const editing = Boolean(id)
  const nav = useNavigate()
  const qc = useQueryClient()
  const [form, setForm] = useState<FormState>(DEFAULTS)
  const [touchedName, setTouchedName] = useState(editing)

  const existing = useQuery({ queryKey: ["monitor", id], queryFn: () => api<{ monitor: Monitor }>(`/api/monitors/${id}`), enabled: editing })
  const channels = useQuery({ queryKey: ["channels"], queryFn: () => api<{ channels: Channel[] }>("/api/channels") })
  useEffect(() => {
    if (existing.data) setForm(fromMonitor(existing.data.monitor))
  }, [existing.data])

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: form.name, url: form.url, method: form.method, intervalSeconds: form.intervalSeconds, timeoutMs: form.timeoutMs,
        expectedStatusMin: form.expectedStatusMin, expectedStatusMax: form.expectedStatusMax, keyword: form.keyword || null,
        failureThreshold: form.failureThreshold, recoveryThreshold: form.recoveryThreshold,
        slowThresholdMs: form.slowThresholdMs ? Number(form.slowThresholdMs) : null,
        headers: parseHeaders(form.headers), body: form.method === "POST" ? form.body || null : null, channelIds: form.channelIds,
      }
      return editing
        ? api<{ monitor: Monitor }>(`/api/monitors/${id}`, { method: "PATCH", body })
        : api<{ monitor: Monitor }>("/api/monitors", { method: "POST", body })
    },
    onSuccess: async ({ monitor }) => {
      await qc.invalidateQueries({ queryKey: ["monitors"] })
      await qc.invalidateQueries({ queryKey: ["monitor", monitor.id] })
      nav(`/monitors/${monitor.id}`)
    },
  })

  if (editing && existing.isLoading) return <Loading />
  const err = save.error instanceof ApiError ? save.error : null
  const f = err?.fields ?? {}
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((s) => ({ ...s, [k]: v }))

  const onUrl = (url: string) => {
    set("url", url)
    if (!touchedName) {
      try {
        set("name", new URL(url).hostname.replace(/^www\./, ""))
      } catch {
        /* keep typing */
      }
    }
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    save.mutate()
  }

  return (
    <>
      <div className="page-head">
        <div>
          <Link to={editing ? `/monitors/${id}` : "/"} className="back">← {editing ? "Back to monitor" : "Monitors"}</Link>
          <h1>{editing ? `Edit ${existing.data?.monitor.name ?? "monitor"}` : "Add monitor"}</h1>
        </div>
      </div>

      <form className="form" onSubmit={submit} noValidate style={{ maxWidth: 720 }}>
        {err && <div className="alert" role="alert">{err.message}</div>}
        {save.error && !err && <ErrorNote error={save.error} />}

        <fieldset className="fieldset">
          <legend>What to check</legend>
          <Field label="URL" htmlFor="url" error={f.url} hint="The page or API endpoint Pingwell should request">
            <input id="url" className="input mono" value={form.url} onChange={(e) => onUrl(e.target.value)} aria-invalid={!!f.url} autoFocus={!editing} inputMode="url" />
          </Field>
          <Field label="Name" htmlFor="name" error={f.name}>
            <input id="name" className="input" value={form.name} onChange={(e) => { setTouchedName(true); set("name", e.target.value) }} aria-invalid={!!f.name} />
          </Field>
          <div className="row">
            <Field label="Check" htmlFor="interval" error={f.intervalSeconds}>
              <select id="interval" className="select" value={form.intervalSeconds} onChange={(e) => set("intervalSeconds", Number(e.target.value))}>
                {[...new Set([...INTERVALS, form.intervalSeconds])].sort((a, b) => a - b).map((s) => <option key={s} value={s}>{s < 60 ? `Every ${s} seconds` : s < 3600 ? `Every ${s / 60} minute${s === 60 ? "" : "s"}` : "Every hour"}</option>)}
              </select>
            </Field>
            <Field label="Method" htmlFor="method">
              <select id="method" className="select" value={form.method} onChange={(e) => set("method", e.target.value as FormState["method"])}>
                <option>GET</option><option>HEAD</option><option>POST</option>
              </select>
            </Field>
            <Field label="Timeout" htmlFor="timeout" error={f.timeoutMs}>
              <select id="timeout" className="select" value={form.timeoutMs} onChange={(e) => set("timeoutMs", Number(e.target.value))}>
                {[5000, 10000, 20000, 30000].map((t) => <option key={t} value={t}>{t / 1000} seconds</option>)}
              </select>
            </Field>
          </div>
        </fieldset>

        <fieldset className="fieldset">
          <legend>What counts as up</legend>
          <div className="row">
            <Field label="Lowest OK status" htmlFor="smin" error={f.expectedStatusMin}>
              <input id="smin" type="number" className="input mono" value={form.expectedStatusMin} onChange={(e) => set("expectedStatusMin", Number(e.target.value))} />
            </Field>
            <Field label="Highest OK status" htmlFor="smax" error={f.expectedStatusMax}>
              <input id="smax" type="number" className="input mono" value={form.expectedStatusMax} onChange={(e) => set("expectedStatusMax", Number(e.target.value))} />
            </Field>
            <Field label="Slow above (ms)" htmlFor="slow" hint="Optional. Marks the monitor amber." error={f.slowThresholdMs}>
              <input id="slow" type="number" className="input mono" placeholder="e.g. 1500" value={form.slowThresholdMs} onChange={(e) => set("slowThresholdMs", e.target.value)} />
            </Field>
          </div>
          <Field label="Page must contain" htmlFor="keyword" hint="Optional. Catches error pages that still return 200." error={f.keyword}>
            <input id="keyword" className="input" placeholder="e.g. Add to cart" value={form.keyword} onChange={(e) => set("keyword", e.target.value)} />
          </Field>
        </fieldset>

        <fieldset className="fieldset">
          <legend>When to alert</legend>
          <div className="row">
            <Field label="Open an incident after" htmlFor="fail" hint="Consecutive failed checks. 2 filters out one-off blips.">
              <select id="fail" className="select" value={form.failureThreshold} onChange={(e) => set("failureThreshold", Number(e.target.value))}>
                {[1, 2, 3, 5].map((n) => <option key={n} value={n}>{n} failed check{n > 1 ? "s" : ""}</option>)}
              </select>
            </Field>
            <Field label="Resolve after" htmlFor="rec" hint="Consecutive successful checks.">
              <select id="rec" className="select" value={form.recoveryThreshold} onChange={(e) => set("recoveryThreshold", Number(e.target.value))}>
                {[1, 2, 3].map((n) => <option key={n} value={n}>{n} successful check{n > 1 ? "s" : ""}</option>)}
              </select>
            </Field>
          </div>
          <div className="field">
            <span style={{ fontSize: 13.5, fontWeight: 500 }}>Send alerts to</span>
            {channels.data?.channels.length ? (
              channels.data.channels.map((c) => (
                <label key={c.id} className="check">
                  <input
                    type="checkbox"
                    checked={form.channelIds.includes(c.id)}
                    onChange={(e) => set("channelIds", e.target.checked ? [...form.channelIds, c.id] : form.channelIds.filter((x) => x !== c.id))}
                  />
                  {c.name} <span className="muted small">({c.type})</span>
                </label>
              ))
            ) : (
              <span className="hint">No alert channels yet. <Link to="/channels">Add one</Link> to get notified.</span>
            )}
          </div>
        </fieldset>

        <details className="fieldset">
          <summary style={{ cursor: "pointer", fontWeight: 600, fontSize: 14 }}>Request headers and body</summary>
          <Field label="Headers" htmlFor="headers" hint="One per line, e.g. Authorization: Bearer abc" error={f.headers}>
            <textarea id="headers" className="textarea" value={form.headers} onChange={(e) => set("headers", e.target.value)} />
          </Field>
          {form.method === "POST" && (
            <Field label="Body" htmlFor="body" error={f.body}>
              <textarea id="body" className="textarea" value={form.body} onChange={(e) => set("body", e.target.value)} />
            </Field>
          )}
        </details>

        <div className="btn-row">
          <button className="btn btn-primary" disabled={save.isPending}>{save.isPending ? "Saving…" : editing ? "Save changes" : "Add monitor"}</button>
          <Link to={editing ? `/monitors/${id}` : "/"} className="btn">Cancel</Link>
        </div>
      </form>
    </>
  )
}
