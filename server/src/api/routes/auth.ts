import { hash, verify } from "@node-rs/argon2"
import type { FastifyInstance, FastifyReply } from "fastify"
import { z } from "zod"
import { config } from "../../config.js"
import { db } from "../../db/pool.js"
import { HttpError, parse, userId } from "../http.js"

export const SESSION_COOKIE = "pw_session"
const SESSION_DAYS = 7

const Register = z.object({
  name: z.string().trim().min(1, "Enter your name").max(80),
  email: z.string().trim().toLowerCase().email("Enter a valid email address").max(200),
  password: z.string().min(10, "Use at least 10 characters").max(200),
})
const Login = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address"),
  password: z.string().min(1, "Enter your password"),
})

// Verified against when the email doesn't exist, so login takes the same time either way.
let dummyHash: Promise<string> | undefined
const getDummyHash = () => (dummyHash ??= hash("pingwell-timing-equaliser"))

function setSession(app: FastifyInstance, reply: FastifyReply, user: { id: string; email: string }) {
  const token = app.jwt.sign({ sub: user.id, email: user.email }, { expiresIn: `${SESSION_DAYS}d` })
  reply.setCookie(SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax", // blocks cross-site POSTs from carrying the cookie (CSRF)
    secure: config().COOKIE_SECURE,
    maxAge: SESSION_DAYS * 24 * 3600,
  })
}

export async function authRoutes(app: FastifyInstance) {
  const strict = { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }

  app.post("/register", strict, async (req, reply) => {
    if (!config().ALLOW_REGISTRATION) throw new HttpError(403, "Registration is closed on this Pingwell instance")
    const input = parse(Register, req.body)
    const passwordHash = await hash(input.password)
    try {
      const res = await db().query<{ id: string; email: string; name: string }>(
        "INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id, email, name",
        [input.email, input.name, passwordHash],
      )
      const user = res.rows[0]!
      setSession(app, reply, user)
      return reply.code(201).send({ user })
    } catch (err) {
      if ((err as { code?: string }).code === "23505") throw new HttpError(409, "An account with this email already exists", { fields: { email: "Already registered" } })
      throw err
    }
  })

  app.post("/login", strict, async (req, reply) => {
    const input = parse(Login, req.body)
    const res = await db().query<{ id: string; email: string; name: string; password_hash: string }>(
      "SELECT id, email, name, password_hash FROM users WHERE lower(email) = $1",
      [input.email],
    )
    const user = res.rows[0]
    const valid = await verify(user?.password_hash ?? (await getDummyHash()), input.password).catch(() => false)
    if (!user || !valid) throw new HttpError(401, "Email or password is incorrect")
    setSession(app, reply, user)
    return { user: { id: user.id, email: user.email, name: user.name } }
  })

  app.post("/logout", async (_req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: "/" })
    return { ok: true }
  })

  app.get("/me", { onRequest: [app.authenticate] }, async (req) => {
    const res = await db().query("SELECT id, email, name, created_at AS \"createdAt\" FROM users WHERE id = $1", [userId(req)])
    if (!res.rows[0]) throw new HttpError(401, "Your session has ended. Sign in again.")
    return { user: res.rows[0] }
  })
}
