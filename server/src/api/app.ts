import cookie from "@fastify/cookie"
import cors from "@fastify/cors"
import helmet from "@fastify/helmet"
import jwt from "@fastify/jwt"
import rateLimit from "@fastify/rate-limit"
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify"
import { config } from "../config.js"
import { logger } from "../logger.js"
import { redis } from "../redis.js"
import { httpRequests } from "../system/metrics.js"
import { HttpError } from "./http.js"
import { authRoutes, SESSION_COOKIE } from "./routes/auth.js"
import { channelRoutes } from "./routes/channels.js"
import { incidentRoutes } from "./routes/incidents.js"
import { monitorRoutes } from "./routes/monitors.js"
import { publicRoutes, statusPageRoutes } from "./routes/status-pages.js"
import { systemRoutes } from "./routes/system.js"

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>
  }
}
declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: { sub: string; email: string }
    user: { sub: string; email: string }
  }
}

export async function buildApp() {
  const cfg = config()
  const app = Fastify({
    loggerInstance: logger,
    trustProxy: cfg.TRUST_PROXY === "true" ? true : cfg.TRUST_PROXY === "false" ? false : cfg.TRUST_PROXY,
    bodyLimit: 256 * 1024,
  })

  await app.register(helmet, { contentSecurityPolicy: false }) // JSON API; the web app sets its own CSP
  await app.register(cors, {
    origin: cfg.CORS_ORIGIN.split(",").map((s) => s.trim()),
    credentials: true,
    methods: ["GET", "POST", "PATCH", "DELETE"],
  })
  await app.register(cookie)
  await app.register(jwt, { secret: cfg.JWT_SECRET, cookie: { cookieName: SESSION_COOKIE, signed: false } })
  if (cfg.RATE_LIMIT) {
    await app.register(rateLimit, {
      max: 300,
      timeWindow: "1 minute",
      redis: redis(), // counters shared across API replicas
      nameSpace: "pingwell:ratelimit:",
      allowList: (req) => req.url === "/health" || req.url === "/health/ready",
    })
  }

  app.decorate("authenticate", async (req: FastifyRequest) => {
    try {
      await req.jwtVerify()
    } catch {
      throw new HttpError(401, "Sign in to continue")
    }
  })

  app.setErrorHandler((err: Error & { statusCode?: number; validation?: unknown; details?: unknown }, req, reply) => {
    if (err instanceof HttpError) {
      return reply.code(err.statusCode).send({ error: err.message, ...(err.details ? (err.details as object) : {}) })
    }
    if (err.statusCode === 429) return reply.code(429).send({ error: "Too many requests. Wait a minute and try again." })
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message })
    req.log.error({ err }, "unhandled error")
    return reply.code(500).send({ error: "Something went wrong on our side. Try again in a moment." })
  })
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: "Not found" }))

  app.addHook("onResponse", async (req, reply) => {
    httpRequests.inc({ method: req.method, route: req.routeOptions.url ?? "unmatched", status: String(reply.statusCode) })
  })

  await app.register(systemRoutes)
  await app.register(authRoutes, { prefix: "/api/auth" })
  await app.register(monitorRoutes, { prefix: "/api/monitors" })
  await app.register(incidentRoutes, { prefix: "/api/incidents" })
  await app.register(channelRoutes, { prefix: "/api/channels" })
  await app.register(statusPageRoutes, { prefix: "/api/status-pages" })
  await app.register(publicRoutes, { prefix: "/api/public" })

  return app
}
