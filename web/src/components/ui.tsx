import type { ReactNode } from "react"
import type { Status } from "../api"

export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="#14171c" />
      <path d="M5 17h6l3-8 4 15 3-7h6" fill="none" stroke="#3ccf7f" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function statusTone(status: Status, slow = false): "up" | "down" | "slow" | "idle" {
  if (status === "down") return "down"
  if (status === "up") return slow ? "slow" : "up"
  return "idle"
}

export function Dot({ tone, label }: { tone: "up" | "down" | "slow" | "idle"; label?: string }) {
  return <span className={`dot ${tone}`} role="img" aria-label={label ?? tone} />
}

export function Field({ label, hint, error, children, htmlFor }: { label: string; hint?: string; error?: string; children: ReactNode; htmlFor: string }) {
  return (
    <div className="field">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {error ? <span className="err" id={`${htmlFor}-err`}>{error}</span> : hint ? <span className="hint">{hint}</span> : null}
    </div>
  )
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  )
}

export function Loading() {
  return <p className="muted" style={{ padding: 20 }}>Loading…</p>
}

export function ErrorNote({ error }: { error: unknown }) {
  return <div className="alert" role="alert">{error instanceof Error ? error.message : "Something went wrong"}</div>
}
