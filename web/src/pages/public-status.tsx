import { useQuery } from "@tanstack/react-query"
import { useEffect } from "react"
import { useParams } from "react-router-dom"
import { api, ApiError } from "../api"
import { UptimeBars } from "../components/charts"
import { Dot, Logo } from "../components/ui"
import { dateTime, duration, pct } from "../format"

type PublicStatus = {
  title: string
  description: string | null
  overall: "operational" | "partial_outage" | "major_outage"
  monitors: { name: string; status: "up" | "down" | "maintenance"; uptime90d: number | null; history: { day: string; upPct: number | null }[] }[]
  incidents: { id: string; monitorName: string; startedAt: string; resolvedAt: string | null; durationSeconds: number }[]
  generatedAt: string
}

const OVERALL = { operational: "All systems operational", partial_outage: "Some systems are down", major_outage: "Major outage" } as const
const LABEL = { up: "Operational", down: "Down", maintenance: "Paused for maintenance" } as const

export function PublicStatusPage() {
  const { slug } = useParams()
  const q = useQuery({ queryKey: ["public", slug], queryFn: () => api<PublicStatus>(`/api/public/status/${slug}`), refetchInterval: 60_000, retry: false })
  useEffect(() => {
    if (q.data) document.title = `${q.data.title} · Status`
  }, [q.data])

  if (q.isLoading) return <div className="pub"><p className="muted">Loading status…</p></div>
  if (q.error) {
    const notFound = q.error instanceof ApiError && q.error.status === 404
    return (
      <div className="pub">
        <h1>{notFound ? "Status page not found" : "Status unavailable"}</h1>
        <p className="pub-desc">{notFound ? "Check the link. This page may have been renamed or unpublished." : "We couldn't load the status right now. Try again in a minute."}</p>
      </div>
    )
  }
  const d = q.data!

  return (
    <div className="pub">
      <h1>{d.title}</h1>
      {d.description && <p className="pub-desc">{d.description}</p>}

      <div className={`overall ${d.overall}`} role="status">
        <Dot tone={d.overall === "operational" ? "up" : d.overall === "partial_outage" ? "slow" : "down"} label={OVERALL[d.overall]} />
        {OVERALL[d.overall]}
      </div>

      <section className="card" aria-label="Services">
        {d.monitors.length === 0 && <p className="muted" style={{ padding: 20 }}>No services are listed yet.</p>}
        {d.monitors.map((m) => (
          <div key={m.name} className="pub-mon">
            <div className="pub-mon-head">
              <b style={{ fontWeight: 500 }}>{m.name}</b>
              <span className={`badge ${m.status === "up" ? "up" : m.status === "down" ? "down" : ""}`}>{LABEL[m.status]}</span>
            </div>
            <UptimeBars items={m.history.map((h) => ({ label: h.day, upPct: h.upPct }))} />
            <div className="bars-legend"><span>90 days ago</span><span className="mono">{pct(m.uptime90d, 3)} uptime</span><span>Today</span></div>
          </div>
        ))}
      </section>

      <h2 style={{ fontSize: 17, fontWeight: 600, margin: "32px 0 12px" }}>Past 14 days</h2>
      <section className="card">
        {d.incidents.length === 0 ? (
          <p className="muted" style={{ padding: 20 }}>No incidents reported.</p>
        ) : (
          <table className="table">
            <tbody>
              {d.incidents.map((i) => (
                <tr key={i.id}>
                  <td><b style={{ fontWeight: 500 }}>{i.monitorName}</b> {i.resolvedAt ? "was unavailable" : "is unavailable"}</td>
                  <td className="mono small muted">{dateTime(i.startedAt)}</td>
                  <td className="mono small" style={{ textAlign: "right" }}>{i.resolvedAt ? duration(i.durationSeconds) : "Ongoing"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <p className="pub-foot">
        Updated {new Date(d.generatedAt).toLocaleTimeString()} · <a href="https://github.com/Wealthometer/pingwell" style={{ display: "inline-flex", alignItems: "center", gap: 4, verticalAlign: "middle" }}><Logo size={14} /> Powered by Pingwell</a>
      </p>
    </div>
  )
}
