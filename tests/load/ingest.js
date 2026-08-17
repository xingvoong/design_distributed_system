/**
 * Load test: ingestion throughput
 * Target: 10,000 docs/hour = ~2.8 docs/sec sustained
 *
 * Run: k6 run tests/load/ingest.js
 * With stack: GATEWAY_URL=http://localhost:3000 k6 run tests/load/ingest.js
 */
import http from 'k6/http'
import { check, sleep } from 'k6'
import { Rate, Trend } from 'k6/metrics'

const errorRate = new Rate('ingest_errors')
const ingestDuration = new Trend('ingest_duration_ms', true)

const GATEWAY_URL = __ENV.GATEWAY_URL || 'http://localhost:3000'
const API_KEY = __ENV.API_KEY || 'dev-key-1'

// Ramp to 3 docs/sec over 1 minute, hold for 3 minutes, ramp down.
// 3 docs/sec × 3 min = 540 docs in the sustained window.
// Extrapolated: ~10,800 docs/hour — validates the 10k target.
export const options = {
  stages: [
    { duration: '1m', target: 3 },   // ramp up
    { duration: '3m', target: 3 },   // sustained load
    { duration: '30s', target: 0 },  // ramp down
  ],
  thresholds: {
    ingest_errors: ['rate<0.01'],           // <1% errors
    ingest_duration_ms: ['p(95)<2000'],     // 95% of responses under 2s (async — just queuing)
    http_req_failed: ['rate<0.01'],
  },
}

// Minimal text document — small enough to be realistic, big enough to produce chunks
const DOCUMENT_CONTENT = Array(20)
  .fill('Distributed systems require careful coordination between components to ensure reliability.')
  .join(' ')

export default function () {
  const tenantId = `tenant-${Math.floor(__VU % 10)}`  // 10 simulated tenants

  const formData = {
    tenantId,
    file: http.file(DOCUMENT_CONTENT, 'doc.txt', 'text/plain'),
  }

  const start = Date.now()
  const res = http.post(`${GATEWAY_URL}/ingest`, formData, {
    headers: { 'x-api-key': API_KEY },
  })
  ingestDuration.add(Date.now() - start)

  const ok = check(res, {
    'status is 202': (r) => r.status === 202,
    'has documentId': (r) => {
      try { return JSON.parse(r.body).documentId !== undefined } catch { return false }
    },
  })

  errorRate.add(!ok)
  sleep(0.1)
}
