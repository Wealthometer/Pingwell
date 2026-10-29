import { useQuery } from "@tanstack/react-query"
import { api, type SystemStatus } from "../api"
import { Dot, ErrorNote, Loading } from "../components/ui"
import { timeAgo } from "../format"

const VERDICT = { healthy: "Pingwell is running normally", degraded: "Pingwell is running with problems", down: "Checks have stopped" } as const

export function System() {
  const q = useQuery({ queryKey: ["system"], queryFn: () => api<SystemStatus>("/api/system"), refetchInterval: 5_000 })
  if (q.isLoading) return <Loading />
  if (q.error || !q.data) return <ErrorNote error={q.error} />
  const s = q.data
  const tone = s.verdict === "healthy" ? "up" : s.verdict === "degraded" ? "slow" : "down"

  return (
    <>
      <div className="page-head">
        <div>
          <h1>System</h1>
          <p>Who watches the watcher: the health of Pingwell's own workers, scheduler and queues.</p>
        </div>
      </div>
      <div className="stack">
        <div className={`overall ${s.verdict === "healthy" ? "operational" : s.verdict === "degraded" ? "partial_outage" : "major_outage"}`} style={{ margin: 0 }} role="status">
          <Dot tone={tone} label={s.verdict} /> {VERDICT[s.verdict]}
        </div>
        {s.problems.length > 0 && (
          <ul className="card card-pad" style={{ paddingLeft: 36 }}>
            {s.problems.map((p) => <li key={p}>{p}</li>)}
          </ul>
        )}

        <dl className="figures">
          <div className="figure"><dt>Live workers</dt><dd>{s.workers.length}</dd></div>
          <div className="figure"><dt>Scheduler last ran</dt><dd style={{ fontSize: 18 }}>{timeAgo(s.schedulerLastTick)}</dd></div>
          <div className="figure"><dt>Behind schedule</dt><dd>{s.schedulerLagSeconds}<small>s</small></dd></div>
          <div className="figure"><dt>Checks waiting</dt><dd>{(s.queues.checks.waiting ?? 0) + (s.queues.checks.delayed ?? 0)}</dd></div>
        </dl>

        <div className="grid-2" style={{ alignItems: "start" }}>
          <section className="card" aria-labelledby="w">
            <div className="card-head"><h2 id="w">Workers</h2></div>
            <div className="table-wrap"><table className="table">
              <thead><tr><th>Worker</th><th>Started</th><th style={{ textAlign: "right" }}>Checks</th><th style={{ textAlign: "right" }}>Alerts</th></tr></thead>
              <tbody>
                {s.workers.map((w) => (
                  <tr key={w.id}>
                    <td className="mono small">{w.id}</td>
                    <td className="small muted">{timeAgo(w.startedAt)}</td>
                    <td className="mono" style={{ textAlign: "right" }}>{w.checksProcessed}</td>
                    <td className="mono" style={{ textAlign: "right" }}>{w.alertsProcessed}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
            {s.workers.length === 0 && <p style={{ padding: 20, color: "var(--down)" }}>No workers have reported in the last 30 seconds. Start one with <code className="mono">npm run start:worker</code>.</p>}
          </section>

          <section className="card" aria-labelledby="qs">
            <div className="card-head"><h2 id="qs">Queues</h2></div>
            <div className="table-wrap"><table className="table">
              <thead><tr><th>Queue</th><th style={{ textAlign: "right" }}>Waiting</th><th style={{ textAlign: "right" }}>Active</th><th style={{ textAlign: "right" }}>Retrying</th><th style={{ textAlign: "right" }}>Failed</th></tr></thead>
              <tbody>
                {(["checks", "alerts"] as const).map((name) => (
                  <tr key={name}>
                    <td style={{ textTransform: "capitalize" }}>{name}</td>
                    {(["waiting", "active", "delayed", "failed"] as const).map((k) => <td key={k} className="mono" style={{ textAlign: "right" }}>{s.queues[name][k] ?? 0}</td>)}
                  </tr>
                ))}
              </tbody>
            </table></div>
          </section>
        </div>
      </div>
    </>
  )
}
