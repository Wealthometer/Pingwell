import { Redis } from "ioredis"
import { config } from "./config.js"

const connections: Redis[] = []

/** BullMQ requires maxRetriesPerRequest: null on its connections. */
export function createRedis(): Redis {
  const r = new Redis(config().REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: true })
  connections.push(r)
  return r
}

let shared: Redis | undefined
export function redis(): Redis {
  shared ??= createRedis()
  return shared
}

export async function closeRedis() {
  shared = undefined
  await Promise.all(connections.splice(0).map((c) => c.quit().catch(() => c.disconnect())))
}

export const KEY = {
  workerHeartbeat: (id: string) => `pingwell:worker:${id}`,
  workerPattern: "pingwell:worker:*",
  schedulerTick: "pingwell:scheduler:last_tick",
  lock: (name: string) => `pingwell:lock:${name}`,
}

/** Simple single-holder lock (SET NX PX). Good enough for periodic maintenance jobs. */
export async function tryLock(name: string, ttlMs: number, owner: string): Promise<boolean> {
  return (await redis().set(KEY.lock(name), owner, "PX", ttlMs, "NX")) === "OK"
}
