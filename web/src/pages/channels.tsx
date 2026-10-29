import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState, type FormEvent } from "react"
import { api, ApiError, type Channel } from "../api"
import { Empty, ErrorNote, Field, Loading } from "../components/ui"

const TYPES = {
  slack: { label: "Slack", field: "url", fieldLabel: "Incoming webhook URL", placeholder: "https://hooks.slack.com/services/…" },
  discord: { label: "Discord", field: "url", fieldLabel: "Webhook URL", placeholder: "https://discord.com/api/webhooks/…" },
  email: { label: "Email", field: "to", fieldLabel: "Send to", placeholder: "oncall@example.com" },
  webhook: { label: "Webhook", field: "url", fieldLabel: "Endpoint URL", placeholder: "https://example.com/hooks/pingwell" },
} as const
type ChannelType = keyof typeof TYPES

export function Channels() {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ["channels"], queryFn: () => api<{ channels: Channel[] }>("/api/channels") })
  const [type, setType] = useState<ChannelType>("slack")
  const [name, setName] = useState("")
  const [value, setValue] = useState("")
  const [secret, setSecret] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<Record<string, string>>({})

  const create = useMutation({
    mutationFn: () =>
      api<{ channel: Channel; secret?: string }>("/api/channels", {
        method: "POST",
        body: { type, name: name || TYPES[type].label, config: { [TYPES[type].field]: value } },
      }),
    onSuccess: (res) => {
      setName("")
      setValue("")
      setSecret(res.secret ?? null)
      void qc.invalidateQueries({ queryKey: ["channels"] })
    },
  })
  const toggle = useMutation({
    mutationFn: (c: Channel) => api(`/api/channels/${c.id}`, { method: "PATCH", body: { enabled: !c.enabled } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["channels"] }),
  })
  const remove = useMutation({
    mutationFn: (c: Channel) => api(`/api/channels/${c.id}`, { method: "DELETE" }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["channels"] }),
  })
  const test = async (c: Channel) => {
    setTestResult((r) => ({ ...r, [c.id]: "Sending…" }))
    try {
      await api(`/api/channels/${c.id}/test`, { method: "POST" })
      setTestResult((r) => ({ ...r, [c.id]: "Test alert sent" }))
    } catch (e) {
      setTestResult((r) => ({ ...r, [c.id]: e instanceof Error ? e.message : "Failed" }))
    }
  }

  const err = create.error instanceof ApiError ? create.error : null
  const fieldErr = err?.fields[`config.${TYPES[type].field}`]
  const submit = (e: FormEvent) => {
    e.preventDefault()
    create.mutate()
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Alert channels</h1>
          <p>Where Pingwell tells you something went down, and again when it recovers.</p>
        </div>
      </div>

      <div className="grid-2" style={{ alignItems: "start" }}>
        <section className="card" aria-labelledby="yours">
          <div className="card-head"><h2 id="yours">Your channels</h2></div>
          {q.isLoading ? <Loading /> : q.data?.channels.length ? (
            <table className="table">
              <tbody>
                {q.data.channels.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <b style={{ fontWeight: 500 }}>{c.name}</b> <span className="muted small">{TYPES[c.type].label}</span>
                      <div className="mono muted small truncate" style={{ maxWidth: 260 }}>{c.config.to ?? c.config.url}</div>
                      <div className="small muted">{c.monitors} monitor{c.monitors === 1 ? "" : "s"}{!c.enabled && " · turned off"}</div>
                      {testResult[c.id] && <div className="small" role="status">{testResult[c.id]}</div>}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <div className="btn-row" style={{ justifyContent: "flex-end" }}>
                        <button className="btn btn-sm" onClick={() => void test(c)}>Send test</button>
                        <button className="btn btn-sm" onClick={() => toggle.mutate(c)}>{c.enabled ? "Turn off" : "Turn on"}</button>
                        <button className="btn btn-sm btn-danger" onClick={() => { if (confirm(`Delete "${c.name}"? Monitors will stop alerting it.`)) remove.mutate(c) }}>Delete</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty title="No channels yet">Add one on the right, then pick it on each monitor.</Empty>
          )}
        </section>

        <section className="card card-pad" aria-labelledby="add">
          <h2 id="add" style={{ fontSize: 15, fontWeight: 600, marginBottom: 14 }}>Add a channel</h2>
          <form className="form" onSubmit={submit} noValidate>
            {err && !fieldErr && <div className="alert" role="alert">{err.message}</div>}
            {secret && (
              <div className="alert ok" role="status">
                Channel added. Your signing secret (shown once) is <code className="mono" style={{ wordBreak: "break-all" }}>{secret}</code>. Verify the <code>x-pingwell-signature</code> header with it.
              </div>
            )}
            <div className="ranges" role="group" aria-label="Channel type" style={{ alignSelf: "flex-start" }}>
              {(Object.keys(TYPES) as ChannelType[]).map((t) => (
                <button type="button" key={t} aria-pressed={type === t} onClick={() => { setType(t); setValue(""); create.reset() }}>{TYPES[t].label}</button>
              ))}
            </div>
            <Field label="Name" htmlFor="cname" hint="Something you'll recognise, like #ops-alerts">
              <input id="cname" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={TYPES[type].label} />
            </Field>
            <Field label={TYPES[type].fieldLabel} htmlFor="cval" error={fieldErr} hint={type === "webhook" ? "We POST JSON signed with HMAC-SHA256" : undefined}>
              <input id="cval" className="input mono" value={value} onChange={(e) => setValue(e.target.value)} placeholder={TYPES[type].placeholder} aria-invalid={!!fieldErr} />
            </Field>
            <button className="btn btn-primary" disabled={!value || create.isPending}>{create.isPending ? "Adding…" : `Add ${TYPES[type].label} channel`}</button>
          </form>
          {create.error && !err && <ErrorNote error={create.error} />}
        </section>
      </div>
    </>
  )
}
