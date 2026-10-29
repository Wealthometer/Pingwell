import { useQuery } from "@tanstack/react-query"
import { Link } from "react-router-dom"
import { api, type Monitor } from "../api"
import { Sparkline } from "../components/charts"
import { Dot, Empty, ErrorNote, Loading, statusTone } from "../components/ui"
import { ms, pct, STATUS_LABEL, timeAgo } from "../format"

export function Monitors() {
  const q = useQuery({ queryKey: ["monitors"], queryFn: () => api<{ monitors: Monitor[] }>("/api/monitors"), refetchInterval: 10_000 })
  const monitors = q.data?.monitors ?? []
  const down = monitors.filter((m) => m.status === "down").length
  const up = monitors.filter((m) => m.status === "up").length
  const paused = monitors.filter((m) => m.paused).length

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Monitors</h1>
          <p>{monitors.length === 0 ? "Nothing is being watched yet." : down ? `${down} of ${monitors.length} down right now.` : "Everything is up."}</p>
        </div>
        <Link to="/monitors/new" className="btn btn-primary">Add monitor</Link>
      </div>

      {q.error && <ErrorNote error={q.error} />}
      {monitors.length > 0 && (
        <div className="summary">
          <span><b>{up}</b>up</span>
          <span><b>{down}</b>down</span>
          <span><b>{paused}</b>paused</span>
        </div>
      )}

      <div className="card">
        {q.isLoading ? (
          <Loading />
        ) : monitors.length === 0 ? (
          <Empty title="Add your first monitor" action={<Link to="/monitors/new" className="btn btn-primary">Add monitor</Link>}>
            Give Pingwell a URL and it will check it on a schedule and alert you when it goes down.
          </Empty>
        ) : (
          <>
            <div className="mrow mhead" aria-hidden="true">
              <span />
              <span>Name</span>
              <span>Last 40 checks</span>
              <span style={{ textAlign: "right" }}>24h uptime</span>
              <span style={{ textAlign: "right" }}>Response</span>
              <span style={{ textAlign: "right" }}>Checked</span>
            </div>
            <ul className="mlist">
              {monitors.map((m) => {
                const slow = m.slowThresholdMs !== null && (m.lastResponseMs ?? 0) > m.slowThresholdMs
                return (
                  <li key={m.id}>
                    <Link to={`/monitors/${m.id}`} className={`mrow${m.status === "down" ? " is-down" : ""}`}>
                      <Dot tone={statusTone(m.status, slow)} label={STATUS_LABEL[m.status]} />
                      <span style={{ minWidth: 0 }}>
                        <span className="name truncate" style={{ display: "block" }}>{m.name}</span>
                        <span className="url truncate" style={{ display: "block" }}>{m.status === "down" && m.lastError ? m.lastError : m.url}</span>
                      </span>
                      <Sparkline points={m.sparkline ?? []} />
                      <span className="num">{pct(m.uptime24h)}</span>
                      <span className="num">{m.status === "down" ? "—" : ms(m.lastResponseMs)}</span>
                      <span className="when">{m.paused ? "Paused" : timeAgo(m.lastCheckedAt)}</span>
                    </Link>
                  </li>
                )
              })}
            </ul>
          </>
        )}
      </div>
    </>
  )
}
