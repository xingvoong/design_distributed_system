/**
 * Load test: query latency
 * Target: p99 < 100ms
 *
 * Run: k6 run tests/load/query.js
 * With stack: GATEWAY_URL=http://localhost:3000 k6 run tests/load/query.js
 *
 * Note: run ingest.js first to populate the vector store,
 * otherwise queries return empty results immediately (fast but meaningless).
 */
import http from 'k6/http'
import { check, sleep } from 'k6'
import { Rate } from 'k6/metrics'

const errorRate = new Rate('query_errors')

const GATEWAY_URL = __ENV.GATEWAY_URL || 'http://localhost:3000'
const API_KEY = __ENV.API_KEY || 'dev-key-1'

export const options = {
  stages: [
    { duration: '30s', target: 10 },   // ramp up to 10 concurrent users
    { duration: '3m', target: 10 },    // sustained
    { duration: '1m', target: 50 },    // spike
    { duration: '1m', target: 10 },    // recover
    { duration: '30s', target: 0 },    // ramp down
  ],
  thresholds: {
    query_errors: ['rate<0.01'],
    http_req_duration: ['p(99)<100'],   // the target: p99 under 100ms
    http_req_failed: ['rate<0.01'],
  },
}

const QUERIES = [
  'distributed systems fault tolerance',
  'machine learning embeddings',
  'vector database similarity search',
  'horizontal scaling techniques',
  'leader election consensus',
]

export default function () {
  const tenantId = `tenant-${Math.floor(__VU % 10)}`
  const query = QUERIES[Math.floor(Math.random() * QUERIES.length)]

  const res = http.post(
    `${GATEWAY_URL}/query`,
    JSON.stringify({ query, tenantId, topK: 10 }),
    {
      headers: {
        'x-api-key': API_KEY,
        'content-type': 'application/json',
      },
    },
  )

  const ok = check(res, {
    'status is 200': (r) => r.status === 200,
    'has results array': (r) => {
      try { return Array.isArray(JSON.parse(r.body).results) } catch { return false }
    },
  })

  errorRate.add(!ok)
  sleep(0.1)
}
