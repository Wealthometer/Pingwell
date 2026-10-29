import { useMemo, useState } from "react"
import type { Stats } from "../api"
import { ms } from "../format"

/** Tiny latency trace for the monitors list. Failed checks drop to the baseline in red. */
export function Sparkline({ points, width = 120, height = 28 }: { points: { ok: boolean; ms: number | null }[]; width?: number; height?: number }) {
  if (points.length < 2) return <svg width={width} height={height} aria-hidden="true" />
  const values = points.map((p) => (p.ok ? p.ms ?? 0 : 0))
  const max = Math.max(...values, 1)
  const step = width / (points.length - 1)
  const y = (v: number) => height - 2 - (v / max) * (height - 4)
  const d = values.map((v, i) => `${i ? "L" : "M"}${(i * step).toFixed(1)},${y(v).toFixed(1)}`).join("")
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <path d={d} fill="none" stroke="#7b8394" strokeWidth="1.4" strokeLinejoin="round" />
      {points.map((p, i) => (!p.ok ? <circle key={i} cx={i * step} cy={height - 2} r="2.2" fill="#e5484d" /> : null))}
    </svg>
  )
}

/** Response-time chart with failed periods shaded red. Hover shows the bucket. */
export function ResponseChart({ series, range }: { series: Stats["series"]; range: string }) {
  const [hover, setHover] = useState<number | null>(null)
  const W = 900
  const H = 220
  const pad = { l: 46, r: 12, t: 12, b: 24 }
  const iw = W - pad.l - pad.r
  const ih = H - pad.t - pad.b

  const { max, ticks } = useMemo(() => {
    const top = Math.max(...series.map((s) => s.avgMs ?? 0), 10)
    const nice = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000].find((n) => n >= top) ?? top
    return { max: nice, ticks: [0, nice / 2, nice] }
  }, [series])

  if (series.length === 0) return null
  const step = iw / Math.max(series.length - 1, 1)
  const x = (i: number) => pad.l + i * step
  const y = (v: number) => pad.t + ih - (v / max) * ih

  let line = ""
  let area = ""
  let pen = false
  series.forEach((s, i) => {
    if (s.avgMs === null) {
      pen = false
      return
    }
    line += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(s.avgMs).toFixed(1)}`
    pen = true
  })
  const firstIdx = series.findIndex((s) => s.avgMs !== null)
  if (firstIdx >= 0) {
    const pts = series.map((s, i) => [i, s.avgMs] as const).filter(([, v]) => v !== null) as [number, number][]
    area = `M${x(pts[0]![0])},${y(0)}` + pts.map(([i, v]) => `L${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("") + `L${x(pts[pts.length - 1]![0])},${y(0)}Z`
  }
  const label = (t: string) => {
    const d = new Date(t)
    return range === "24h" ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : d.toLocaleDateString(undefined, { month: "short", day: "numeric" })
  }
  const h = hover !== null ? series[hover] : null

  return (
    <div style={{ position: "relative" }}>
      <svg
        className="chart"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="Average response time over the selected range"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect()
          const px = ((e.clientX - rect.left) / rect.width) * W
          setHover(Math.max(0, Math.min(series.length - 1, Math.round((px - pad.l) / step))))
        }}
      >
        {series.map((s, i) =>
          s.upPct !== null && s.upPct < 100 ? (
            <rect key={`f${i}`} x={x(i) - step / 2} y={pad.t} width={Math.max(step, 2)} height={ih} fill="#e5484d" opacity={s.upPct === 0 ? 0.22 : 0.12} />
          ) : null,
        )}
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke="#e1e3de" />
            <text x={pad.l - 8} y={y(t) + 4} textAnchor="end">{ms(t)}</text>
          </g>
        ))}
        <path d={area} fill="#14171c" opacity="0.06" />
        <path d={line} fill="none" stroke="#14171c" strokeWidth="1.6" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
        {[0, Math.floor(series.length / 2), series.length - 1].map((i) => (
          <text key={i} x={x(i)} y={H - 6} textAnchor={i === 0 ? "start" : i === series.length - 1 ? "end" : "middle"}>{label(series[i]!.t)}</text>
        ))}
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={pad.t + ih} stroke="#7b8394" strokeDasharray="3 3" />}
      </svg>
      {h && (
        <div className="card small" style={{ position: "absolute", top: 8, right: 12, padding: "6px 10px", pointerEvents: "none" }}>
          <span className="mono">{label(h.t)}</span> · {h.checks ? <>avg <b className="mono">{ms(h.avgMs)}</b> · up <b className="mono">{h.upPct}%</b></> : "no checks"}
        </div>
      )}
    </div>
  )
}

/** One bar per bucket: green all up, amber some failures, red mostly down, grey no data. */
export function UptimeBars({ items }: { items: { label: string; upPct: number | null }[] }) {
  return (
    <div className="bars" role="img" aria-label="Uptime history">
      {items.map((it, i) => {
        const cls = it.upPct === null ? "" : it.upPct >= 99.9 ? "up" : it.upPct >= 90 ? "partial" : "down"
        return <span key={i} className={cls} title={`${it.label}: ${it.upPct === null ? "no data" : `${it.upPct}% up`}`} />
      })}
    </div>
  )
}
