import client from "prom-client"

export const registry = new client.Registry()
client.collectDefaultMetrics({ register: registry, prefix: "pingwell_" })

export const checksTotal = new client.Counter({
  name: "pingwell_checks_total",
  help: "Checks performed, by result",
  labelNames: ["result"] as const,
  registers: [registry],
})

export const checkDuration = new client.Histogram({
  name: "pingwell_check_duration_seconds",
  help: "Target response time as measured by the checker",
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
  registers: [registry],
})

export const scheduledTotal = new client.Counter({
  name: "pingwell_scheduler_enqueued_total",
  help: "Checks enqueued by the scheduler",
  registers: [registry],
})

export const schedulerLag = new client.Gauge({
  name: "pingwell_scheduler_lag_seconds",
  help: "How long the most overdue monitor has been waiting",
  registers: [registry],
})

export const incidentsTotal = new client.Counter({
  name: "pingwell_incident_transitions_total",
  help: "Incidents opened and resolved",
  labelNames: ["action"] as const,
  registers: [registry],
})

export const alertsTotal = new client.Counter({
  name: "pingwell_alerts_total",
  help: "Alert delivery attempts by outcome",
  labelNames: ["outcome"] as const,
  registers: [registry],
})

export const httpRequests = new client.Counter({
  name: "pingwell_http_requests_total",
  help: "API requests",
  labelNames: ["method", "route", "status"] as const,
  registers: [registry],
})

export const queueDepth = new client.Gauge({
  name: "pingwell_queue_jobs",
  help: "Jobs in each queue by state",
  labelNames: ["queue", "state"] as const,
  registers: [registry],
})
