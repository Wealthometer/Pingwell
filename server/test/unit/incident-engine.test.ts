import { describe, expect, it } from "vitest"
import { evaluate, formatDuration, type EngineState } from "../../src/monitoring/incident-engine.js"

const base: EngineState = { status: "up", consecutiveFailures: 0, consecutiveSuccesses: 5, failureThreshold: 2, recoveryThreshold: 1, hasOpenIncident: false }

/** Feeds a sequence of results through the engine, tracking incident state like the DB would. */
function run(start: EngineState, results: boolean[]) {
  let s = { ...start }
  const actions: string[] = []
  for (const ok of results) {
    const t = evaluate(s, ok)
    actions.push(t.action)
    s = {
      ...s,
      status: t.status,
      consecutiveFailures: t.consecutiveFailures,
      consecutiveSuccesses: t.consecutiveSuccesses,
      hasOpenIncident: t.action === "open_incident" ? true : t.action === "resolve_incident" ? false : s.hasOpenIncident,
    }
  }
  return { state: s, actions }
}

describe("incident engine", () => {
  it("ignores a single failed check below the threshold", () => {
    const { state, actions } = run(base, [false, true])
    expect(actions).toEqual(["none", "none"])
    expect(state.status).toBe("up")
  })

  it("opens exactly one incident once failures reach the threshold", () => {
    const { state, actions } = run(base, [false, false, false, false])
    expect(actions).toEqual(["none", "open_incident", "none", "none"])
    expect(state.status).toBe("down")
    expect(state.consecutiveFailures).toBe(4)
  })

  it("opens immediately with a threshold of 1", () => {
    expect(evaluate({ ...base, failureThreshold: 1 }, false).action).toBe("open_incident")
  })

  it("resolves on the first success with a recovery threshold of 1", () => {
    const { actions, state } = run(base, [false, false, true])
    expect(actions.at(-1)).toBe("resolve_incident")
    expect(state.status).toBe("up")
  })

  it("needs N consecutive successes to resolve, and a failure resets the count (no flapping)", () => {
    const { actions, state } = run({ ...base, recoveryThreshold: 3 }, [false, false, true, true, false, true, true, true])
    expect(actions).toEqual(["none", "open_incident", "none", "none", "none", "none", "none", "resolve_incident"])
    expect(state.hasOpenIncident).toBe(false)
  })

  it("stays down while recovering", () => {
    const t = evaluate({ ...base, status: "down", hasOpenIncident: true, recoveryThreshold: 2, consecutiveSuccesses: 0 }, true)
    expect(t).toMatchObject({ status: "down", action: "none", consecutiveSuccesses: 1 })
  })

  it("keeps a pending monitor pending until it either succeeds or crosses the threshold", () => {
    expect(evaluate({ ...base, status: "pending", consecutiveSuccesses: 0 }, false).status).toBe("pending")
    expect(evaluate({ ...base, status: "pending" }, true).status).toBe("up")
  })
})

describe("formatDuration", () => {
  it.each([
    [0, "0s"],
    [45_000, "45s"],
    [125_000, "2m 5s"],
    [3_660_000, "1h 1m"],
    [90_000_000, "1d 1h"],
  ])("%i ms → %s", (ms, text) => expect(formatDuration(ms)).toBe(text))
})
