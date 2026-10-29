import { randomBytes } from "node:crypto"
import type { FastifyInstance } from "fastify"
import { z } from "zod"
import { send, type ChannelConfig } from "../../alerts/senders.js"
import { config } from "../../config.js"
import { db } from "../../db/pool.js"
import { assertAllowedUrl } from "../../monitoring/ssrf.js"
import { HttpError, notFound, parse, userId, uuidParam } from "../http.js"

const webhookUrl = (hosts?: string[]) =>
  z
    .string()
    .trim()
    .url("Enter a full URL")
    .superRefine((v, ctx) => {
      try {
        const u = assertAllowedUrl(v, config().ALLOW_PRIVATE_TARGETS)
        if (hosts && !hosts.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`)))
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Expected a ${hosts[0]} webhook URL` })
      } catch (err) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: (err as Error).message })
      }
    })

const ChannelInput = z.discriminatedUnion("type", [
  z.object({ type: z.literal("email"), name: z.string().trim().min(1).max(80), config: z.object({ to: z.string().trim().email("Enter a valid email address") }) }),
  z.object({ type: z.literal("slack"), name: z.string().trim().min(1).max(80), config: z.object({ url: webhookUrl(["hooks.slack.com"]) }) }),
  z.object({ type: z.literal("discord"), name: z.string().trim().min(1).max(80), config: z.object({ url: webhookUrl(["discord.com", "discordapp.com"]) }) }),
  z.object({
    type: z.literal("webhook"),
    name: z.string().trim().min(1).max(80),
    config: z.object({ url: webhookUrl(), secret: z.string().min(16).max(200).optional() }),
  }),
])
const UpdateChannel = z.object({ name: z.string().trim().min(1).max(80).optional(), enabled: z.boolean().optional() })

/** Webhook URLs are credentials. Only show enough to recognise them. */
function mask(type: string, cfg: Record<string, string>) {
  if (type === "email") return { to: cfg.to }
  const u = new URL(cfg.url!)
  const path = u.pathname.length > 12 ? `${u.pathname.slice(0, 10)}…` : u.pathname
  return { url: `${u.protocol}//${u.host}${path}`, ...(type === "webhook" ? { secret: "••••••••" } : {}) }
}

export async function channelRoutes(app: FastifyInstance) {
  app.addHook("onRequest", app.authenticate)

  app.get("/", async (req) => {
    const res = await db().query<{ id: string; type: string; name: string; config: Record<string, string>; enabled: boolean; monitors: number }>(
      `SELECT c.id, c.type, c.name, c.config, c.enabled, c.created_at AS "createdAt",
              (SELECT count(*)::int FROM monitor_channels mc WHERE mc.channel_id = c.id) AS monitors
         FROM alert_channels c WHERE c.user_id = $1 ORDER BY c.created_at`,
      [userId(req)],
    )
    return { channels: res.rows.map((c) => ({ ...c, config: mask(c.type, c.config) })) }
  })

  app.post("/", async (req, reply) => {
    const input = parse(ChannelInput, req.body)
    const cfg: Record<string, string> = { ...input.config }
    if (input.type === "webhook" && !cfg.secret) cfg.secret = randomBytes(24).toString("hex")
    const res = await db().query(
      `INSERT INTO alert_channels (user_id, type, name, config) VALUES ($1, $2, $3, $4)
       RETURNING id, type, name, enabled, created_at AS "createdAt"`,
      [userId(req), input.type, input.name, cfg],
    )
    // The webhook signing secret is returned once, at creation, so it can be copied into the receiver.
    return reply.code(201).send({ channel: { ...res.rows[0], config: mask(input.type, cfg) }, ...(input.type === "webhook" ? { secret: cfg.secret } : {}) })
  })

  app.patch("/:id", async (req) => {
    const { id } = parse(uuidParam, req.params)
    const input = parse(UpdateChannel, req.body)
    const res = await db().query(
      `UPDATE alert_channels SET name = COALESCE($3, name), enabled = COALESCE($4, enabled)
        WHERE id = $1 AND user_id = $2 RETURNING id, type, name, config, enabled`,
      [id, userId(req), input.name ?? null, input.enabled ?? null],
    )
    const c = res.rows[0]
    if (!c) throw notFound("Channel")
    return { channel: { ...c, config: mask(c.type, c.config) } }
  })

  app.delete("/:id", async (req, reply) => {
    const { id } = parse(uuidParam, req.params)
    const res = await db().query("DELETE FROM alert_channels WHERE id = $1 AND user_id = $2", [id, userId(req)])
    if (!res.rowCount) throw notFound("Channel")
    return reply.code(204).send()
  })

  app.post("/:id/test", { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (req) => {
    const { id } = parse(uuidParam, req.params)
    const res = await db().query<{ type: ChannelConfig["type"]; config: ChannelConfig["config"]; name: string }>(
      "SELECT type, config, name FROM alert_channels WHERE id = $1 AND user_id = $2",
      [id, userId(req)],
    )
    const c = res.rows[0]
    if (!c) throw notFound("Channel")
    try {
      await send({ type: c.type, config: c.config } as ChannelConfig, {
        kind: "test",
        monitorName: "Test",
        monitorUrl: config().PUBLIC_APP_URL,
        title: `Test alert from Pingwell`,
        detail: `If you can read this, alerts to "${c.name}" are working.`,
        incidentUrl: `${config().PUBLIC_APP_URL}/channels`,
        at: new Date(),
      })
    } catch (err) {
      throw new HttpError(502, `Test alert failed: ${(err as Error).message}`)
    }
    return { ok: true }
  })
}
