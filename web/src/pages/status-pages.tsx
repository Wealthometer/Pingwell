import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useState, type FormEvent } from "react"
import { Link, useNavigate, useParams } from "react-router-dom"
import { api, ApiError, type Monitor, type StatusPage } from "../api"
import { Empty, ErrorNote, Field, Loading } from "../components/ui"

export function StatusPages() {
  const q = useQuery({ queryKey: ["status-pages"], queryFn: () => api<{ statusPages: StatusPage[] }>("/api/status-pages") })
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Status pages</h1>
          <p>Public pages that show your customers what's up, without exposing your URLs or errors.</p>
        </div>
        <Link to="/status-pages/new" className="btn btn-primary">New status page</Link>
      </div>
      <div className="card">
        {q.isLoading ? <Loading /> : q.data?.statusPages.length ? (
          <table className="table">
            <thead><tr><th>Page</th><th>Address</th><th>Monitors</th><th /></tr></thead>
            <tbody>
              {q.data.statusPages.map((p) => (
                <tr key={p.id}>
                  <td><b style={{ fontWeight: 500 }}>{p.title}</b>{!p.published && <span className="badge" style={{ marginLeft: 8 }}>Hidden</span>}</td>
                  <td><a className="mono small" href={`/s/${p.slug}`} target="_blank" rel="noreferrer">/s/{p.slug}</a></td>
                  <td className="mono">{p.monitorCount}</td>
                  <td style={{ textAlign: "right" }}><Link to={`/status-pages/${p.id}`} className="btn btn-sm">Edit</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty title="No status pages yet" action={<Link to="/status-pages/new" className="btn btn-primary">New status page</Link>}>
            Pick which monitors to show and share the link.
          </Empty>
        )}
      </div>
    </>
  )
}

type Item = { monitorId: string; displayName: string }

export function StatusPageEditor() {
  const { id } = useParams()
  const editing = Boolean(id)
  const nav = useNavigate()
  const qc = useQueryClient()
  const [title, setTitle] = useState("")
  const [slug, setSlug] = useState("")
  const [description, setDescription] = useState("")
  const [published, setPublished] = useState(true)
  const [items, setItems] = useState<Item[]>([])

  const monitors = useQuery({ queryKey: ["monitors"], queryFn: () => api<{ monitors: Monitor[] }>("/api/monitors") })
  const page = useQuery({ queryKey: ["status-page", id], queryFn: () => api<{ statusPage: StatusPage }>(`/api/status-pages/${id}`), enabled: editing })
  useEffect(() => {
    const p = page.data?.statusPage
    if (!p) return
    setTitle(p.title)
    setSlug(p.slug)
    setDescription(p.description ?? "")
    setPublished(p.published)
    setItems((p.monitors ?? []).map((m) => ({ monitorId: m.monitorId, displayName: m.displayName ?? "" })))
  }, [page.data])

  const save = useMutation({
    mutationFn: () => {
      const body = { title, slug, description: description || null, published, monitors: items.map((i) => ({ monitorId: i.monitorId, displayName: i.displayName || null })) }
      return editing ? api<{ statusPage: StatusPage }>(`/api/status-pages/${id}`, { method: "PATCH", body }) : api<{ statusPage: StatusPage }>("/api/status-pages", { method: "POST", body })
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["status-pages"] })
      nav("/status-pages")
    },
  })
  const remove = useMutation({
    mutationFn: () => api(`/api/status-pages/${id}`, { method: "DELETE" }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["status-pages"] })
      nav("/status-pages")
    },
  })

  if (editing && page.isLoading) return <Loading />
  const err = save.error instanceof ApiError ? save.error : null
  const f = err?.fields ?? {}
  const byId = new Map((monitors.data?.monitors ?? []).map((m) => [m.id, m]))
  const available = (monitors.data?.monitors ?? []).filter((m) => !items.some((i) => i.monitorId === m.id))
  const move = (i: number, d: -1 | 1) => setItems((list) => {
    const next = [...list]
    const j = i + d
    if (j < 0 || j >= next.length) return list
    ;[next[i], next[j]] = [next[j]!, next[i]!]
    return next
  })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    save.mutate()
  }

  return (
    <>
      <div className="page-head">
        <div>
          <Link to="/status-pages" className="back">← Status pages</Link>
          <h1>{editing ? `Edit ${page.data?.statusPage.title ?? "status page"}` : "New status page"}</h1>
        </div>
        {editing && slug && <a className="btn" href={`/s/${slug}`} target="_blank" rel="noreferrer">Open public page</a>}
      </div>
      <form className="form" onSubmit={submit} noValidate style={{ maxWidth: 720 }}>
        {err && <div className="alert" role="alert">{err.message}</div>}
        <fieldset className="fieldset">
          <legend>Page</legend>
          <Field label="Title" htmlFor="title" error={f.title}>
            <input id="title" className="input" value={title} placeholder="Acme status" onChange={(e) => {
              setTitle(e.target.value)
              if (!editing) setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50))
            }} />
          </Field>
          <Field label="Address" htmlFor="slug" error={f.slug} hint={`${location.origin}/s/${slug || "your-page"}`}>
            <input id="slug" className="input mono" value={slug} onChange={(e) => setSlug(e.target.value)} aria-invalid={!!f.slug} />
          </Field>
          <Field label="Description" htmlFor="desc" hint="Optional, shown under the title">
            <input id="desc" className="input" value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          <label className="check"><input type="checkbox" checked={published} onChange={(e) => setPublished(e.target.checked)} /> Published (anyone with the link can see it)</label>
        </fieldset>

        <fieldset className="fieldset">
          <legend>Monitors on this page</legend>
          {items.length === 0 && <p className="muted small">Add the monitors your customers care about. You can rename them, e.g. "api-prod-eu" → "API".</p>}
          {items.map((it, i) => (
            <div key={it.monitorId} style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr) auto", gap: 8, alignItems: "center" }}>
              <span className="truncate small">{byId.get(it.monitorId)?.name ?? "Monitor"}</span>
              <input className="input" aria-label="Public name" placeholder="Public name (optional)" value={it.displayName}
                onChange={(e) => setItems((l) => l.map((x, n) => (n === i ? { ...x, displayName: e.target.value } : x)))} />
              <div className="btn-row">
                <button type="button" className="btn btn-sm" onClick={() => move(i, -1)} aria-label="Move up" disabled={i === 0}>↑</button>
                <button type="button" className="btn btn-sm" onClick={() => move(i, 1)} aria-label="Move down" disabled={i === items.length - 1}>↓</button>
                <button type="button" className="btn btn-sm btn-danger" onClick={() => setItems((l) => l.filter((_, n) => n !== i))}>Remove</button>
              </div>
            </div>
          ))}
          {available.length > 0 && (
            <select className="select" value="" aria-label="Add a monitor" onChange={(e) => e.target.value && setItems((l) => [...l, { monitorId: e.target.value, displayName: "" }])}>
              <option value="">Add a monitor…</option>
              {available.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          )}
        </fieldset>

        <div className="btn-row">
          <button className="btn btn-primary" disabled={save.isPending}>{save.isPending ? "Saving…" : editing ? "Save changes" : "Create status page"}</button>
          <Link to="/status-pages" className="btn">Cancel</Link>
          {editing && <button type="button" className="btn btn-danger" style={{ marginLeft: "auto" }} onClick={() => { if (confirm("Delete this status page? The public link will stop working.")) remove.mutate() }}>Delete page</button>}
        </div>
        {save.error && !err && <ErrorNote error={save.error} />}
      </form>
    </>
  )
}
