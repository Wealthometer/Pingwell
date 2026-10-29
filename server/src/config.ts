import { z } from "zod"

const bool = z
  .enum(["true", "false", "1", "0"])
  .optional()
  .transform((v) => v === "true" || v === "1")

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(4000),
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  COOKIE_SECURE: bool,
  CORS_ORIGIN: z.string().default("http://localhost:5173"),
  /** Which proxies may set X-Forwarded-For (affects rate limiting by IP). Default: private networks only. */
  TRUST_PROXY: z.string().default("loopback,uniquelocal"),
  PUBLIC_APP_URL: z.string().url().default("http://localhost:5173"),

  /** Allow checks against localhost / private networks. Keep false on a public deployment (SSRF). */
  ALLOW_PRIVATE_TARGETS: bool,
  MIN_INTERVAL_SECONDS: z.coerce.number().int().min(10).default(30),
  CHECK_CONCURRENCY: z.coerce.number().int().min(1).max(500).default(25),
  SCHEDULER_INTERVAL_MS: z.coerce.number().int().min(500).default(5000),
  SCHEDULER_BATCH_SIZE: z.coerce.number().int().min(1).default(500),
  RESULT_RETENTION_DAYS: z.coerce.number().int().min(1).default(90),
  MAX_MONITORS_PER_USER: z.coerce.number().int().min(1).default(50),
  WORKER_METRICS_PORT: z.coerce.number().int().positive().default(9465),
  /** If set, GET /metrics requires `Authorization: Bearer <token>`. */
  METRICS_TOKEN: z.string().optional(),
  RATE_LIMIT: z
    .enum(["true", "false", "1", "0"])
    .default("true")
    .transform((v) => v === "true" || v === "1"),
  /** Set to false to stop new sign-ups (e.g. after creating your own account). */
  ALLOW_REGISTRATION: z
    .enum(["true", "false", "1", "0"])
    .default("true")
    .transform((v) => v === "true" || v === "1"),

  SMTP_URL: z.string().optional(),
  MAIL_FROM: z.string().default("Pingwell <alerts@pingwell.local>"),

  /** Optional dead man's switch: the scheduler pings this URL every minute (e.g. healthchecks.io). */
  HEARTBEAT_URL: z.string().url().optional(),
})

export type Config = z.infer<typeof schema>

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")
    throw new Error(`Invalid configuration:\n${issues}`)
  }
  return parsed.data
}

let cached: Config | undefined
export function config(): Config {
  cached ??= loadConfig()
  return cached
}

/** Test helper: reset cached config after mutating process.env. */
export function resetConfig() {
  cached = undefined
}
