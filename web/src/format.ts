export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "never"
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 5) return "just now"
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

export function duration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  if (m < 60) return `${m}m ${seconds % 60}s`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

export function pct(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined) return "—"
  return `${Number(v).toFixed(v === 100 ? 0 : digits)}%`
}

export function ms(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—"
  return v >= 1000 ? `${(v / 1000).toFixed(2)}s` : `${v}ms`
}

export function dateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" })
}

export function every(seconds: number): string {
  if (seconds < 60) return `every ${seconds}s`
  if (seconds % 3600 === 0) return `every ${seconds / 3600}h`
  return `every ${Math.round(seconds / 60)}m`
}

export const STATUS_LABEL = { up: "Up", down: "Down", pending: "Waiting for first check", paused: "Paused" } as const
