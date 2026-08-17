import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import Fastify, { type FastifyInstance } from 'fastify'
import { createAuthHandler } from '../auth.js'
import { createRateLimiter } from '../rate-limiter.js'
import { registerRoutes } from '../routes.js'

// ─── stub upstream servers ────────────────────────────────────────────────────

interface StubResponse {
  status: number
  body: unknown
}

function startStubServer(
  handler: (url: string) => StubResponse,
): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const stub = handler(req.url ?? '')
      res.writeHead(stub.status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(stub.body))
    })
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number }
      resolve({ server, url: `http://127.0.0.1:${addr.port}` })
    })
  })
}

// ─── app factory ─────────────────────────────────────────────────────────────

function buildApp(ingestUrl: string, queryUrl: string, keys = ['test-key'], maxRequests = 100) {
  const app = Fastify({ logger: false })

  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
    try {
      done(null, JSON.parse((body as Buffer).toString()))
    } catch (err) {
      done(err as Error)
    }
  })

  app.addHook('preHandler', async (req) => {
    if (Buffer.isBuffer(req.body)) {
      req.rawBody = req.body
    } else if (req.body !== null && req.body !== undefined) {
      req.rawBody = Buffer.from(JSON.stringify(req.body))
    }
  })

  registerRoutes(app, {
    ingestUrl,
    queryUrl,
    authHandler: createAuthHandler({ validKeys: new Set(keys) }),
    rateLimitHandler: createRateLimiter({ maxRequests, windowMs: 60_000 }),
  })

  return app
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe('POST /ingest', () => {
  let app: FastifyInstance
  let ingestServer: Server
  let ingestUrl: string

  beforeAll(async () => {
    ;({ server: ingestServer, url: ingestUrl } = await startStubServer((url) =>
      url === '/ingest'
        ? { status: 202, body: { documentId: 'doc-123' } }
        : { status: 404, body: { error: 'not found' } },
    ))
    app = buildApp(ingestUrl, 'http://unused')
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
    ingestServer.close()
  })

  it('proxies to ingest-service and returns its response', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/ingest',
      headers: { 'x-api-key': 'test-key', 'content-type': 'application/json' },
      payload: { tenantId: 'tenant-a', documentId: 'doc-1' },
    })
    expect(res.statusCode).toBe(202)
    expect(res.json()).toMatchObject({ documentId: 'doc-123' })
  })

  it('returns 401 without API key', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/ingest',
      payload: { tenantId: 'tenant-a' },
    })
    expect(res.statusCode).toBe(401)
  })
})

describe('POST /query', () => {
  let app: FastifyInstance
  let queryServer: Server
  let queryUrl: string

  beforeAll(async () => {
    ;({ server: queryServer, url: queryUrl } = await startStubServer((url) =>
      url === '/query'
        ? { status: 200, body: { results: [{ documentId: 'doc-1', score: 0.1, text: 'match' }], durationMs: 5 } }
        : { status: 404, body: { error: 'not found' } },
    ))
    app = buildApp('http://unused', queryUrl)
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
    queryServer.close()
  })

  it('proxies to query-service and returns its response', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/query',
      headers: { 'x-api-key': 'test-key', 'content-type': 'application/json' },
      payload: { query: 'machine learning', tenantId: 'tenant-a' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json<{ results: Array<{ documentId: string }> }>()
    expect(body.results[0]!.documentId).toBe('doc-1')
  })

  it('returns 401 without API key', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/query',
      payload: { query: 'test', tenantId: 'tenant-a' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('returns 429 when tenant exceeds rate limit', async () => {
    const tinyApp = buildApp('http://unused', queryUrl, ['test-key'], 1)
    await tinyApp.ready()
    try {
      await tinyApp.inject({
        method: 'POST', url: '/query',
        headers: { 'x-api-key': 'test-key', 'content-type': 'application/json' },
        payload: { query: 'first', tenantId: 'tenant-x' },
      })
      const res = await tinyApp.inject({
        method: 'POST', url: '/query',
        headers: { 'x-api-key': 'test-key', 'content-type': 'application/json' },
        payload: { query: 'second', tenantId: 'tenant-x' },
      })
      expect(res.statusCode).toBe(429)
    } finally {
      await tinyApp.close()
    }
  })
})

describe('health endpoints', () => {
  let app: FastifyInstance
  let upServer: Server
  let upUrl: string

  beforeAll(async () => {
    ;({ server: upServer, url: upUrl } = await startStubServer(() => ({
      status: 200,
      body: { status: 'ok' },
    })))
    app = buildApp(upUrl, upUrl)
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
    upServer.close()
  })

  it('/healthz always returns 200', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ status: 'ok' })
  })

  it('/readyz returns 200 when both upstreams are healthy', async () => {
    const res = await app.inject({ method: 'GET', url: '/readyz' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ status: 'ok', ingest: true, query: true })
  })

  it('/readyz returns 503 when an upstream is down', async () => {
    const downApp = buildApp('http://localhost:1', 'http://localhost:1')
    await downApp.ready()
    try {
      const res = await downApp.inject({ method: 'GET', url: '/readyz' })
      expect(res.statusCode).toBe(503)
    } finally {
      await downApp.close()
    }
  })
})
