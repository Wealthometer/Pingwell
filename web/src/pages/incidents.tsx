import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState, type FormEvent } from "react"
import { Link, useParams } from "react-router-dom"
import { api, type Incident, type IncidentEvent } from "../api"
import { Empty, ErrorNote, Loading } from "../components/ui"
import { dateTime, duration, ms, timeAgo } from "../format"

const FILTERS = [["all", "All"], ["open", "Ongoing"], ["resolved", "Resolved"]] as const

export function Incidents() {
  const [filter, setFilter] = useState<(typeof FILTERS)[number][0]>("all")
  const q = useQuery({ queryKey: ["incidents", filter], queryFn: () => api<{ incidents: Incident[] }>(`/api/incidents?status=${filter}`), refetchInterval: 15_000 })
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Incidents</h1>
          <p>Every outage, from first failed check to recovery.</p>
        </div>
        <div className="ranges" role="group" aria-label="Filter incidents">
          {FILTERS.map(([k, label]) => <button key={k} aria-pressed={filter === k} onClick={() => setFilter(k)}>{label}</button>)}
        </div>
      </div>
      {q.error && <ErrorNote error={q.error} />}
      <div className="card">
        {q.isLoading ? <Loading /> : q.data?.incidents.length ? (
          <ul className="ilist">
            {q.data.incidents.map((i) => (
              <li key={i.id}>
                <Link to={`/incidents/${i.id}`} className="irow">
                  <span className={`badge ${i.resolvedAt ? "" : "down"}`}>{i.resolvedAt ? "Resolved" : i.acknowledgedAt ? "Acknowledged" : "Ongoing"}</span>
                  <span style={{ minWidth: 0 }}>
                    <b style={{ fontWeight: 500 }}>{i.monitor.name}</b>
                    <span className="muted small truncate" style={{ display: "block" }}>{i.cause}</span>
                  </span>
                  <span className="small muted">{timeAgo(i.startedAt)}</span>
                  <span className="mono small" style={{ textAlign: "right" }}>{duration(i.durationSeconds)}</span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <Empty title={filter === "open" ? "Nothing is down" : "No incidents yet"}>When a monitor fails its checks, the incident shows up here with a full timeline.</Empty>
        )}
      </div>
    </>
  )
}

export function IncidentDetail() {
  const { id } = useParams()
  const qc = useQueryClient()
  const [note, setNote] = useState("")
  const q = useQuery({
    queryKey: ["incident", id],
    queryFn: () => api<{ incident: Incident; events: IncidentEvent[]; failedChecks: { checkedAt: string; statusCode: number | null; responseMs: number | null; error: string | null }[] }>(`/api/incidents/${id}`),
    refetchInterval: 10_000,
  })
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["incident", id] })
    void qc.invalidateQueries({ queryKey: ["incidents"] })
  }
  const ack = useMutation({ mutationFn: () => api(`/api/incidents/${id}/acknowledge`, { method: "POST" }), onSuccess: invalidate })
  const addNote = useMutation({
    mutationFn: () => api(`/api/incidents/${id}/notes`, { method: "POST", body: { message: note } }),
    onSuccess: () => {
      setNote("")
      invalidate()
    },
  })

  if (q.isLoading) return <Loading />
  if (q.error || !q.data) return <ErrorNote error={q.error} />
  const { incident: i, events, failedChecks } = q.data
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (note.trim()) addNote.mutate()
  }

  return (
    <>
      <div className="page-head">
        <div>
          <Link to="/incidents" className="back">← Incidents</Link>
          <h1>{i.monitor.name} {i.resolvedAt ? "was down" : "is down"}</h1>
          <div className="status-line">
            <span className={`badge ${i.resolvedAt ? "up" : "down"}`}>{i.resolvedAt ? "Resolved" : "Ongoing"}</span>
            <span>Started {dateTime(i.startedAt)}</span>
            <span>· lasted <b className="mono">{duration(i.durationSeconds)}</b>{!i.resolvedAt && " so far"}</span>
            {i.acknowledgedAt && <span>· acknowledged by {i.acknowledgedBy ?? "someone"} {timeAgo(i.acknowledgedAt)}</span>}
          </div>
        </div>
        <div className="btn-row">
          <Link to={`/monitors/${i.monitor.id}`} className="btn">View monitor</Link>
          {!i.resolvedAt && !i.acknowledgedAt && <button className="btn btn-primary" onClick={() => ack.mutate()} disabled={ack.isPending}>Acknowledge</button>}
        </div>
      </div>

      <div className="grid-2" style={{ alignItems: "start" }}>
        <section className="card" aria-labelledby="tl">
          <div className="card-head"><h2 id="tl">Timeline</h2></div>
          <ol className="timeline">
            {events.map((e) => (
              <li key={e.id} className="tl">
                <span className={`tl-mark ${e.type}`} aria-hidden="true" />
                <div>
                  <div className="tl-body">{e.message}</div>
                  <div className="tl-meta mono">{dateTime(e.at)}{e.userName ? ` · ${e.userName}` : ""}</div>
                </div>
              </li>
            ))}
          </ol>
          <form onSubmit={submit} style={{ padding: "12px 20px 18px", borderTop: "1px solid var(--line)", display: "flex", gap: 8 }}>
            <label htmlFor="note" className="sr-only">Add a note</label>
            <input id="note" className="input" placeholder="Add a note, e.g. what you found or changed" value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />
            <button className="btn" disabled={!note.trim() || addNote.isPending}>Add note</button>
          </form>
        </section>

        <section className="card" aria-labelledby="fc">
          <div className="card-head"><h2 id="fc">Failed checks</h2><span className="muted small mono truncate" style={{ maxWidth: "50%" }}>{i.monitor.url}</span></div>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Time</th><th>Error</th><th style={{ textAlign: "right" }}>After</th></tr></thead>
              <tbody>
                {failedChecks.map((c, n) => (
                  <tr key={n}>
                    <td className="mono muted">{dateTime(c.checkedAt)}</td>
                    <td style={{ color: "var(--down)" }}>{c.error ?? `HTTP ${c.statusCode}`}</td>
                    <td className="mono" style={{ textAlign: "right" }}>{ms(c.responseMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </>
  )
}
