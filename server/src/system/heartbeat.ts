import { hostname } from "node:os"
import { randomBytes } from "node:crypto"
import { KEY, redis } from "../redis.js"

export const WORKER_ID = `${hostname()}-${process.pid}-${randomBytes(3).toString("hex")}`
export const HEARTBEAT_INTERVAL_MS = 30_000
/** Survives two missed beats before the worker drops off the health page. */
const TTL_SECONDS = 90

export type WorkerBeat = { id: string; startedAt: string; beatAt: string; checksProcessed: number; alertsProcessed: number }

/** Each worker refreshes a short-lived key. A worker that dies simply expires, so health shows it gone. */
export async function beat(info: Omit<WorkerBeat, "id" | "beatAt">) {
  const value: WorkerBeat = { id: WORKER_ID, beatAt: new Date().toISOString(), ...info }
  await redis().set(KEY.workerHeartbeat(WORKER_ID), JSON.stringify(value), "EX", TTL_SECONDS)
}

export async function clearBeat() {
  await redis().del(KEY.workerHeartbeat(WORKER_ID))
}

export async function liveWorkers(): Promise<WorkerBeat[]> {
  const keys: string[] = []
  let cursor = "0"
  do {
    const [next, batch] = await redis().scan(cursor, "MATCH", KEY.workerPattern, "COUNT", 100)
    cursor = next
    keys.push(...batch)
  } while (cursor !== "0")
  if (keys.length === 0) return []
  const values = await redis().mget(keys)
  return values.filter((v): v is string => Boolean(v)).map((v) => JSON.parse(v) as WorkerBeat)
}

export async function recordSchedulerTick() {
  await redis().set(KEY.schedulerTick, Date.now().toString(), "EX", 3600)
}

export async function lastSchedulerTick(): Promise<Date | null> {
  const v = await redis().get(KEY.schedulerTick)
  return v ? new Date(Number(v)) : null
}
