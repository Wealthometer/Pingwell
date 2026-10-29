import { createHmac } from "node:crypto"
import nodemailer, { type Transporter } from "nodemailer"
import { Agent, fetch } from "undici"
import { config } from "../config.js"
import { logger } from "../logger.js"
import { guardedLookup } from "../monitoring/ssrf.js"

export type AlertMessage = {
  kind: "opened" | "resolved" | "test"
  monitorName: string
  monitorUrl: string
  title: string
  detail: string
  incidentUrl: string
  at: Date
}

export type ChannelConfig =
  | { type: "email"; config: { to: string } }
  | { type: "slack"; config: { url: string } }
  | { type: "discord"; config: { url: string } }
  | { type: "webhook"; config: { url: string; secret: string } }

export const SIGNATURE_HEADER = "x-pingwell-signature"

/** Webhook receivers verify: hex(HMAC-SHA256(secret, `${timestamp}.${body}`)) === v1, and reject stale timestamps. */
export function signPayload(secret: string, body: string, timestamp: number): string {
  const mac = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")
  return `t=${timestamp},v1=${mac}`
}

// Outbound alert webhooks go through the same SSRF guard as checks.
let agent: Agent | undefined
function alertAgent() {
  agent ??= new Agent({ connect: { lookup: guardedLookup(config().ALLOW_PRIVATE_TARGETS) as never } })
  return agent
}

async function postJson(url: string, payload: unknown, headers: Record<string, string> = {}) {
  const body = JSON.stringify(payload)
  const res = await fetch(url, {
    method: "POST",
    body,
    headers: { "content-type": "application/json", "user-agent": "Pingwell-Alerts/1.0", ...headers },
    signal: AbortSignal.timeout(10_000),
    dispatcher: alertAgent(),
  })
  if (!res.ok) {
    const text = (await res.text().catch(() => "")).slice(0, 200)
    throw new Error(`HTTP ${res.status} from ${new URL(url).host}${text ? `: ${text}` : ""}`)
  }
  await res.body?.cancel().catch(() => {})
}

const emoji = { opened: "🔴", resolved: "🟢", test: "🔔" } as const
const colour = { opened: 0xe5484d, resolved: 0x30a46c, test: 0x6e56cf } as const

let mailer: Transporter | undefined
function transport(): Transporter {
  const url = config().SMTP_URL
  mailer ??= url ? nodemailer.createTransport(url) : nodemailer.createTransport({ jsonTransport: true })
  return mailer
}

export async function send(channel: ChannelConfig, msg: AlertMessage): Promise<void> {
  switch (channel.type) {
    case "slack":
      return postJson(channel.config.url, {
        text: `${emoji[msg.kind]} ${msg.title}`,
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: `*${emoji[msg.kind]} ${msg.title}*\n${msg.detail}` } },
          {
            type: "context",
            elements: [{ type: "mrkdwn", text: `<${msg.monitorUrl}|${msg.monitorUrl}> · <${msg.incidentUrl}|Open in Pingwell>` }],
          },
        ],
      })

    case "discord":
      return postJson(channel.config.url, {
        username: "Pingwell",
        embeds: [
          {
            title: `${emoji[msg.kind]} ${msg.title}`,
            description: msg.detail,
            url: msg.incidentUrl,
            color: colour[msg.kind],
            fields: [{ name: "URL", value: msg.monitorUrl }],
            timestamp: msg.at.toISOString(),
          },
        ],
      })

    case "webhook": {
      const payload = {
        event: msg.kind === "test" ? "test" : `incident.${msg.kind}`,
        monitor: { name: msg.monitorName, url: msg.monitorUrl },
        title: msg.title,
        detail: msg.detail,
        incident_url: msg.incidentUrl,
        at: msg.at.toISOString(),
      }
      const body = JSON.stringify(payload)
      const ts = Math.floor(Date.now() / 1000)
      return postJson(channel.config.url, payload, { [SIGNATURE_HEADER]: signPayload(channel.config.secret, body, ts) })
    }

    case "email": {
      const info = await transport().sendMail({
        from: config().MAIL_FROM,
        to: channel.config.to,
        subject: `${emoji[msg.kind]} ${msg.title}`,
        text: `${msg.title}\n\n${msg.detail}\n\nURL: ${msg.monitorUrl}\nIncident: ${msg.incidentUrl}\n`,
      })
      if (!config().SMTP_URL) logger.info({ to: channel.config.to, subject: msg.title, messageId: info.messageId }, "email alert (SMTP_URL not set, logged only)")
      return
    }
  }
}
