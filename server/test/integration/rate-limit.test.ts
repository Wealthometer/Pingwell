import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { buildApp } from "../../src/api/app.js"
import { resetConfig } from "../../src/config.js"
import { closeDb } from "../../src/db/pool.js"
import { closeQueues } from "../../src/queues.js"
import { closeRedis } from "../../src/redis.js"
import { resetState } from "../helpers.js"

let app: Awaited<ReturnType<typeof buildApp>>
beforeAll(async () => {
  process.env.RATE_LIMIT = "true"
  resetConfig()
  await resetState()
  app = await buildApp()
  await app.ready()
})
afterAll(async () => {
  await app.close()
  process.env.RATE_LIMIT = "false"
  resetConfig()
  await closeQueues()
  await closeRedis()
  await closeDb()
})

describe("rate limiting", () => {
  it("slows down password guessing on the login endpoint", async () => {
    const attempt = () => app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "victim@example.com", password: "guess" } })
    const statuses: number[] = []
    for (let i = 0; i < 12; i++) statuses.push((await attempt()).statusCode)
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true)
    expect(statuses.slice(10)).toEqual([429, 429])
    expect((await attempt()).json().error).toMatch(/Too many requests/)
  })

  it("never rate-limits health checks", async () => {
    for (let i = 0; i < 20; i++) expect((await app.inject({ url: "/health" })).statusCode).toBe(200)
  })
})
