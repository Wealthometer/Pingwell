/**
 * Creates a demo account with monitors, 30 days of synthetic history, past incidents, an alert
 * channel and a public status page, so a fresh install has something to look at.
 *
 *   npm run seed:demo -w server
 *   DEMO_BASE_URL=http://localhost:5600 npm run seed:demo -w server   # point monitors elsewhere
 *
 * Sign in with demo@pingwell.dev / pingwell-demo
 */
import { hash } from "@node-rs/argon2"
import { closeDb, db, withTransaction } from "../db/pool.js"

const EMAIL = "demo@pingwell.dev"
const PASSWORD = "pingwell-demo"
const base = process.env.DEMO_BASE_URL

const MONITORS = [
  { name: "Marketing site", url: base ? `${base}/` : "https://example.com/", baseMs: 180, jitter: 60, keyword: null as string | null },
  { name: "Public API", url: base ? `${base}/api/health` : "https://httpbin.org/status/200", baseMs: 95, jitter: 30, keyword: null },
  { name: "Checkout", url: base ? `${base}/checkout` : "https://example.org/", baseMs: 420, jitter: 160, keyword: null, slow: 900 },
  { name: "Docs", url: base ? `${base}/docs` : "https://example.net/", baseMs: 140, jitter: 40, keyword: null },
  { name: "Payments webhook", url: base ? `${base}/webhooks/payments` : "https://httpbin.org/status/200", baseMs: 260, jitter: 90, keyword: null },
]

// Past outages: [monitor index, days ago, duration minutes, cause]
const OUTAGES: [number, number, number, string][] = [
  [2, 18, 23, "Expected status 200–399, got 502"],
  [1, 9, 6, "Timed out after 10000 ms"],
  [4, 4, 41, "Connection refused"],
  [2, 1.3, 12, "Keyword \"Pay now\" not found in response"],
]

function rand(seed: number) {
  // deterministic noise so screenshots are stable
  const x = Math.sin(seed) * 10000
  return x - Math.floor(x)
}

async function main() {
  const passwordHash = await hash(PASSWORD)
  await withTransaction(async (c) => {
    await c.query("DELETE FROM users WHERE lower(email) = $1", [EMAIL])
    const user = (await c.query<{ id: string }>("INSERT INTO users (email, name, password_hash) VALUES ($1, 'Demo', $2) RETURNING id", [EMAIL, passwordHash])).rows[0]!

    const channel = (
      await c.query<{ id: string }>(
        "INSERT INTO alert_channels (user_id, type, name, config) VALUES ($1, 'email', 'On-call email', $2) RETURNING id",
        [user.id, { to: "oncall@example.com" }],
      )
    ).rows[0]!

    const now = Date.now()
    const ids: string[] = []
    for (const [mi, m] of MONITORS.entries()) {
      const id = (
        await c.query<{ id: string }>(
          `INSERT INTO monitors (user_id, name, url, interval_seconds, slow_threshold_ms, status, last_checked_at, last_response_ms, next_check_at)
           VALUES ($1, $2, $3, 60, $4, 'up', now(), $5, now()) RETURNING id`,
          [user.id, m.name, m.url, (m as { slow?: number }).slow ?? null, m.baseMs],
        )
      ).rows[0]!.id
      ids.push(id)
      await c.query("INSERT INTO monitor_channels (monitor_id, channel_id) VALUES ($1, $2)", [id, channel.id])

      // 30 days of results, one every 10 minutes, with a daily traffic curve.
      const rows: string[] = []
      const params: unknown[] = []
      const outages = OUTAGES.filter(([i]) => i === mi).map(([, daysAgo, mins, cause]) => ({
        from: now - daysAgo * 86_400_000,
        to: now - daysAgo * 86_400_000 + mins * 60_000,
        cause,
      }))
      for (let t = now - 30 * 86_400_000; t < now; t += 600_000) {
        const hour = new Date(t).getUTCHours()
        const load = 1 + 0.35 * Math.sin(((hour - 8) / 24) * Math.PI * 2)
        const out = outages.find((o) => t >= o.from && t <= o.to)
        const ms = Math.round(m.baseMs * load + (rand(t / 1000 + mi) - 0.5) * 2 * m.jitter)
        params.push(id, new Date(t), !out, out ? (out.cause.includes("502") ? 502 : null) : 200, out ? (out.cause.startsWith("Timed") ? 10000 : 30) : ms, out?.cause ?? null)
        const n = params.length
        rows.push(`($${n - 5}, $${n - 4}, $${n - 3}, $${n - 2}, $${n - 1}, $${n})`)
        if (rows.length === 1000) {
          await c.query(`INSERT INTO check_results (monitor_id, checked_at, ok, status_code, response_ms, error) VALUES ${rows.join(",")}`, params)
          rows.length = 0
          params.length = 0
        }
      }
      if (rows.length) await c.query(`INSERT INTO check_results (monitor_id, checked_at, ok, status_code, response_ms, error) VALUES ${rows.join(",")}`, params)

      for (const o of outages) {
        const inc = (
          await c.query<{ id: string }>(
            "INSERT INTO incidents (monitor_id, started_at, resolved_at, cause, acknowledged_at, acknowledged_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
            [id, new Date(o.from), new Date(o.to), o.cause, new Date(o.from + 4 * 60_000), user.id],
          )
        ).rows[0]!.id
        const mins = Math.round((o.to - o.from) / 60_000)
        const events: [number, string, string, string | null][] = [
          [o.from, "opened", `Down after 2 consecutive failed checks: ${o.cause}`, null],
          [o.from + 2_000, "alert_sent", "Down alert sent to On-call email (email)", null],
          [o.from + 4 * 60_000, "acknowledged", "Acknowledged", user.id],
          [o.from + 7 * 60_000, "note", mi === 4 ? "Payment provider is rotating TLS certs; their status page confirms." : "Rolling back the last deploy.", user.id],
          [o.to, "resolved", `Recovered after ${mins}m 0s (HTTP 200, ${m.baseMs} ms)`, null],
          [o.to + 2_000, "alert_sent", "Recovery alert sent to On-call email (email)", null],
        ]
        for (const [at, type, message, uid] of events) {
          await c.query("INSERT INTO incident_events (incident_id, at, type, message, user_id) VALUES ($1, $2, $3, $4, $5)", [inc, new Date(at), type, message, uid])
        }
      }
    }

    const page = (
      await c.query<{ id: string }>(
        "INSERT INTO status_pages (user_id, slug, title, description) VALUES ($1, 'demo', 'Acme status', 'Live availability of Acme''s website, API and checkout.') ON CONFLICT (slug) DO UPDATE SET user_id = EXCLUDED.user_id RETURNING id",
        [user.id],
      )
    ).rows[0]!
    await c.query("DELETE FROM status_page_monitors WHERE status_page_id = $1", [page.id])
    const publicNames = ["Website", "API", "Checkout", "Documentation"]
    for (const [i, name] of publicNames.entries()) {
      await c.query("INSERT INTO status_page_monitors (status_page_id, monitor_id, position, display_name) VALUES ($1, $2, $3, $4)", [page.id, ids[i], i, name])
    }
  })
  const count = await db().query("SELECT count(*)::int AS n FROM check_results")
  console.log(`Demo ready: sign in as ${EMAIL} / ${PASSWORD} (${count.rows[0].n} check results). Public page: /s/demo`)
}

main()
  .then(() => closeDb())
  .catch(async (err) => {
    console.error(err)
    await closeDb()
    process.exit(1)
  })
