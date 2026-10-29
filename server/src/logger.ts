import pino from "pino"

const level = process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "test" ? "silent" : "info")
const pretty = process.env.NODE_ENV === "development" && process.stdout.isTTY

export const logger = pino({
  level,
  base: {}, // service is added by setService() in each entrypoint
  redact: { paths: ["req.headers.cookie", "req.headers.authorization", "*.password", "*.secret"], censor: "[redacted]" },
  ...(pretty ? { transport: { target: "pino-pretty", options: { singleLine: true } } } : {}),
})

/** Tags every subsequent log line with the process role (api / worker). */
export function setService(name: string) {
  logger.setBindings({ service: name })
}
