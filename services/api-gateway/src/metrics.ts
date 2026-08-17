import { Counter, Histogram, Registry } from 'prom-client'

export const registry = new Registry()

/** Total HTTP requests through the gateway, labeled by route and status code. */
export const httpRequestsTotal = new Counter({
  name: 'docflow_gateway_requests_total',
  help: 'Total number of requests handled by the API gateway',
  labelNames: ['route', 'status'] as const,
  registers: [registry],
})

/** Request latency in seconds, labeled by route. */
export const httpRequestDurationSeconds = new Histogram({
  name: 'docflow_gateway_request_duration_seconds',
  help: 'Request duration in seconds',
  labelNames: ['route'] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
})
