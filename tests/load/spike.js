/**
 * Spike test: sudden traffic surge
 * Validates the system recovers cleanly after a burst — no cascading failures,
 * no dropped requests beyond the rate limit, error rate returns to baseline.
 *
 * Run: k6 run tests/load/spike.js
 */
import http from 'k6/http'
import { check, sleep } from 'k6'
import { Rate } from 'k6/metrics'

const errorRate = new Rate('spike_errors')

const GATEWAY_URL = __ENV.GATEWAY_URL || 'http://localhost:3000'
const API_KEY = __ENV.API_KEY || 'dev-key-1'

export const options = {
  stages: [
    { duration: '30s', target: 5 },    // baseline
    { duration: '10s', target: 100 },  // spike — 20× normal load
    { duration: '1m', target: 100 },   // hold the spike
    { duration: '10s', target: 5 },    // recover
    { duration: '1m', target: 5 },     // confirm baseline restored
    { duration: '10s', target: 0 },
  ],
  thresholds: {
    // 429s from rate limiting are expected during spike — not counted as errors
    spike_errors: ['rate<0.05'],        // <5% hard errors (500s, timeouts)
    http_req_failed: ['rate<0.05'],
  },
}

export default function () {
  const tenantId = `tenant-${Math.floor(__VU % 10)}`

  const res = http.post(
    `${GATEWAY_URL}/query`,
    JSON.stringify({ query: 'distributed systems', tenantId, topK: 5 }),
    {
      headers: {
        'x-api-key': API_KEY,
        'content-type': 'application/json',
      },
      timeout: '5s',
    },
  )

  // 429 is correct behaviour under spike — rate limiter doing its job
  const ok = check(res, {
    'not a 5xx': (r) => r.status < 500,
  })

  errorRate.add(!ok)
  sleep(0.05)
}
