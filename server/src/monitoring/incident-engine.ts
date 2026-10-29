/**
 * Decides what a single check result means for a monitor. Pure and synchronous, so the rules that
 * decide when people get paged are fully unit-testable.
 *
 * Rules
 * - A monitor goes DOWN only after `failureThreshold` consecutive failures (filters one-off blips).
 * - An open incident resolves only after `recoveryThreshold` consecutive successes (avoids flapping).
 * - Below the failure threshold the visible status doesn't change.
 */
export type MonitorStatus = "pending" | "up" | "down" | "paused"

export type EngineState = {
  status: MonitorStatus
  consecutiveFailures: number
  consecutiveSuccesses: number
  failureThreshold: number
  recoveryThreshold: number
  hasOpenIncident: boolean
}

export type Transition = {
  status: MonitorStatus
  consecutiveFailures: number
  consecutiveSuccesses: number
  action: "none" | "open_incident" | "resolve_incident"
}

export function evaluate(state: EngineState, ok: boolean): Transition {
  if (ok) {
    const successes = state.consecutiveSuccesses + 1
    if (state.hasOpenIncident) {
      if (successes >= state.recoveryThreshold) {
        return { status: "up", consecutiveFailures: 0, consecutiveSuccesses: successes, action: "resolve_incident" }
      }
      return { status: "down", consecutiveFailures: 0, consecutiveSuccesses: successes, action: "none" }
    }
    return { status: "up", consecutiveFailures: 0, consecutiveSuccesses: successes, action: "none" }
  }

  const failures = state.consecutiveFailures + 1
  if (state.hasOpenIncident) {
    return { status: "down", consecutiveFailures: failures, consecutiveSuccesses: 0, action: "none" }
  }
  if (failures >= state.failureThreshold) {
    return { status: "down", consecutiveFailures: failures, consecutiveSuccesses: 0, action: "open_incident" }
  }
  return {
    status: state.status === "paused" ? "pending" : state.status,
    consecutiveFailures: failures,
    consecutiveSuccesses: 0,
    action: "none",
  }
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}
