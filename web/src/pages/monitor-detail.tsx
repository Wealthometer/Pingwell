import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { Link, useNavigate, useParams } from "react-router-dom"
import { api, type CheckResult, type Incident, type Monitor, type Stats } from "../api"
import { ResponseChart, UptimeBars } from "../components/charts"
import { Dot, Empty, ErrorNote, Loading, statusTone } from "../components/ui"
import { dateTime, duration, every, ms, pct, STATUS_LABEL, timeAgo } from "../format"

const RANGES = ["24h", "7d", "30d", "90d"] as const

export function MonitorDetail() {
  const { id } = useParams()
  const nav = useNavigate()
  const qc = useQueryClient()
  const [range, setRange] = useState<(typeof RANGES)[number]>("24h")

  const monitor = useQuery({ queryKey: ["monitor", id], queryFn: () => api<{ monitor: Monitor }>(`/api/monitors/${id}`), refetchInterval: 5_000 })
  const stats = useQuery({ queryKey: ["stats", id, range], queryFn: () => api<Stats>(`/api/monitors/${id}/stats?range=${range}`), refetchInterval: 30_000 })
  const bars = useQuery({ queryKey: ["stats", id, "90d"], queryFn: () => api<Stats>(`/api/monitors/${id}/stats?range=90d`), refetchInterval: 120_000 })
  const results = useQuery({ queryKey: ["results", id], queryFn: () => api<{ results: CheckResult[] }>(`/api/monitors/${id}/results?limit=12`), refetchInterval: 10_000 })
  const incidents = useQuery({ queryKey: ["monitor-incidents", id], queryFn: () => api<{ incidents: Incident[] }>(`/api/monitors/${id}/incidents`), refetchInterval: 15_000 })

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["monitor", id] })
    void qc.invalidateQueries({ queryKey: ["monitors"] })
  }
  const action = useMutation({
    mutationFn: (a: "pause" | "resume" | "check") => api(`/api/monitors/${id}/${a}`, { method: "POST" }),
    onSuccess: (_d, a) => {
      refresh()
      if (a === "check") setTimeout(() => { refresh(); void qc.invalidateQueries({ queryKey: ["results", id] }) }, 2000)
    },
  })
  const remove = useMutation({
    mutationFn: () => api(`/api/monitors/${id}`, { method: "DELETE" }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["monitors"] })
      nav("/")
    },
  })

  if (monitor.isLoading) return <Loading />
  if (monitor.error || !monitor.data) return <ErrorNote error={monitor.error} />
  const m = monitor.data.monitor
  const slow = m.slowThresholdMs !== null && (m.lastResponseMs ?? 0) > m.slowThresholdMs
  const tone = statusTone(m.status, slow)
  const s = stats.data

  return (
    <>
      <div className="page-head">
        <div style={{ minWidth: 0 }}>
          <Link to="/" className="back">← Monitors</Link>
          <h1 className="truncate">{m.name}</h1>
          <div className="status-line">
            <span className={`badge ${tone === "idle" ? "" : tone}`}><Dot tone={tone} label={STATUS_LABEL[m.status]} /> {slow && m.status === "up" ? "Slow" : STATUS_LABEL[m.status]}</span>
            <a href={m.url} target="_blank" rel="noreferrer" className="mono truncate">{m.url}</a>
            <span>· {m.method} {every(m.intervalSeconds)}</span>
            {!m.paused && <span>· checked {timeAgo(m.lastCheckedAt)}</span>}
          </div>
        </div>
        <div className="btn-row">
          <button className="btn" onClick={() => action.mutate("check")} disabled={m.paused || action.isPending}>Check now</button>
          <button className="btn" onClick={() => action.mutate(m.paused ? "resume" : "pause")} disabled={action.isPending}>{m.paused ? "Resume" : "Pause"}</button>
          <Link to={`/monitors/${m.id}/edit`} className="btn">Edit</Link>
          <button
            className="btn btn-danger"
            onClick={() => { if (confirm(`Delete "${m.name}" and all of its history? This can't be undone.`)) remove.mutate() }}
          >Delete</button>
        </div>
      </div>

      <div className="stack">
        {action.error && <ErrorNote error={action.error} />}
        {m.openIncident && (
          <div className="alert" role="status" style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <span><b>Down since {timeAgo(m.openIncident.startedAt).replace(" ago", "")} ago.</b> {m.openIncident.cause}</span>
            <Link to={`/incidents/${m.openIncident.id}`} className="btn btn-sm">View incident</Link>
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <div className="ranges" role="group" aria-label="Time range">
            {RANGES.map((r) => <button key={r} aria-pressed={range === r} onClick={() => setRange(r)}>{r}</button>)}
          </div>
        </div>

        <dl className="figures">
          <div className="figure"><dt>Uptime</dt><dd>{pct(s?.uptimePct, 3)}</dd></div>
          <div className="figure"><dt>Average response</dt><dd>{ms(s?.avgMs)}</dd></div>
          <div className="figure"><dt>95th percentile</dt><dd>{ms(s?.p95Ms)}</dd></div>
          <div className="figure"><dt>Incidents</dt><dd>{s?.incidents.count ?? "—"}{s && s.incidents.downtimeSeconds > 0 && <small>{duration(s.incidents.downtimeSeconds)} down</small>}</dd></div>
        </dl>

        <section className="card" aria-labelledby="rt">
          <div className="card-head"><h2 id="rt">Response time</h2><span className="muted small">{s ? `${s.checks} checks, ${s.failures} failed` : ""}</span></div>
          <div style={{ padding: "8px 8px 4px" }}>
            {s && s.checks > 0 ? <ResponseChart series={s.series} range={range} /> : <Empty title="No checks in this range yet">{m.paused ? "This monitor is paused." : "The first results appear within a minute."}</Empty>}
          </div>
        </section>

        <section className="card card-pad" aria-labelledby="ninety">
          <h2 id="ninety" style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>Last 90 days</h2>
          <UptimeBars items={(bars.data?.series ?? []).map((b) => ({ label: new Date(b.t).toLocaleDateString(), upPct: b.upPct }))} />
          <div className="bars-legend"><span>90 days ago</span><span>{pct(bars.data?.uptimePct, 3)} uptime</span><span>Today</span></div>
        </section>

        <div className="grid-2">
          <section className="card" aria-labelledby="recent">
            <div className="card-head"><h2 id="recent">Recent checks</h2></div>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Time</th><th>Result</th><th style={{ textAlign: "right" }}>Response</th></tr></thead>
                <tbody>
                  {(results.data?.results ?? []).map((r) => (
                    <tr key={r.id}>
                      <td className="mono muted">{dateTime(r.checkedAt)}</td>
                      <td>{r.ok ? <span className="badge up">{r.statusCode}</span> : <span title={r.error ?? ""} style={{ color: "var(--down)" }}>{r.error ?? `HTTP ${r.statusCode}`}</span>}</td>
                      <td className="mono" style={{ textAlign: "right" }}>{ms(r.responseMs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {results.data?.results.length === 0 && <Empty title="No checks yet" />}
            </div>
          </section>

          <section className="card" aria-labelledby="hist">
            <div className="card-head"><h2 id="hist">Incidents</h2></div>
            {incidents.data?.incidents.length ? (
              <ul className="ilist">
                {incidents.data.incidents.map((i) => (
                  <li key={i.id}>
                    <Link to={`/incidents/${i.id}`} className="irow" style={{ gridTemplateColumns: "90px minmax(0,1fr) 80px" }}>
                      <span className={`badge ${i.resolvedAt ? "" : "down"}`}>{i.resolvedAt ? "Resolved" : "Ongoing"}</span>
                      <span className="truncate small">{i.cause}</span>
                      <span className="muted small" style={{ textAlign: "right" }}>{timeAgo(i.startedAt)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty title="No incidents">This monitor hasn't gone down.</Empty>
            )}
          </section>
        </div>
      </div>
    </>
  )
}
