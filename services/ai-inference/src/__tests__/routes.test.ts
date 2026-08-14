import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { registerRoutes } from '../routes.js'
import type { AIAdapter } from '@docflow/ai-adapter'
import type { DocumentChunk } from '@docflow/types'

function makeChunk(index: number): DocumentChunk {
  return {
    documentId: 'doc-1',
    tenantId: 'tenant-a',
    chunkIndex: index,
    text: `chunk ${index}`,
    tokenCount: 10,
  }
}

function makeAdapter(overrides: Partial<AIAdapter> = {}): AIAdapter {
  return {
    async embed(texts) {
      return {
        embeddings: texts.map(() => new Array(1536).fill(0) as number[]),
        provider: 'stub',
        durationMs: 1,
      }
    },
    circuitState: () => 'CLOSED',
    async close() {},
    ...overrides,
  }
}

describe('routes', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    app = Fastify({ logger: false })
  })

  afterEach(async () => {
    await app.close()
  })

  describe('POST /embed', () => {
    it('returns 400 for empty chunks array', async () => {
      registerRoutes(app, makeAdapter())
      const res = await app.inject({
        method: 'POST',
        url: '/embed',
        payload: { chunks: [], tenantId: 'tenant-a', jobId: 'job-1' },
      })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toMatchObject({ error: 'chunks must be a non-empty array' })
    })

    it('returns embeddings for valid chunks', async () => {
      registerRoutes(app, makeAdapter())
      const res = await app.inject({
        method: 'POST',
        url: '/embed',
        payload: {
          chunks: [makeChunk(0), makeChunk(1)],
          tenantId: 'tenant-a',
          jobId: 'job-1',
        },
      })
      expect(res.statusCode).toBe(200)
      const body = res.json<{ embeddings: number[][]; provider: string; durationMs: number }>()
      expect(body.embeddings).toHaveLength(2)
      expect(body.provider).toBe('stub')
      expect(body.durationMs).toBeGreaterThanOrEqual(0)
    })

    it('returns one embedding per chunk', async () => {
      registerRoutes(app, makeAdapter())
      const chunks = [makeChunk(0), makeChunk(1), makeChunk(2)]
      const res = await app.inject({
        method: 'POST',
        url: '/embed',
        payload: { chunks, tenantId: 'tenant-a', jobId: 'job-1' },
      })
      expect(res.json<{ embeddings: number[][] }>().embeddings).toHaveLength(3)
    })

    it('accumulates embeddings across batches', async () => {
      // 100 chunks forces two batches (96 + 4)
      const chunks = Array.from({ length: 100 }, (_, i) => makeChunk(i))
      registerRoutes(app, makeAdapter())
      const res = await app.inject({
        method: 'POST',
        url: '/embed',
        payload: { chunks, tenantId: 'tenant-a', jobId: 'job-1' },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json<{ embeddings: number[][] }>().embeddings).toHaveLength(100)
    })
  })

  describe('GET /healthz', () => {
    it('always returns 200 ok', async () => {
      registerRoutes(app, makeAdapter())
      const res = await app.inject({ method: 'GET', url: '/healthz' })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ status: 'ok' })
    })
  })

  describe('GET /readyz', () => {
    it('returns 200 when circuit is CLOSED', async () => {
      registerRoutes(app, makeAdapter({ circuitState: () => 'CLOSED' }))
      const res = await app.inject({ method: 'GET', url: '/readyz' })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ status: 'ok', circuitState: 'CLOSED' })
    })

    it('returns 200 when circuit is HALF_OPEN', async () => {
      registerRoutes(app, makeAdapter({ circuitState: () => 'HALF_OPEN' }))
      const res = await app.inject({ method: 'GET', url: '/readyz' })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ status: 'ok', circuitState: 'HALF_OPEN' })
    })

    it('returns 503 when circuit is OPEN', async () => {
      registerRoutes(app, makeAdapter({ circuitState: () => 'OPEN' }))
      const res = await app.inject({ method: 'GET', url: '/readyz' })
      expect(res.statusCode).toBe(503)
      expect(res.json()).toMatchObject({ status: 'not ready', circuitState: 'OPEN' })
    })
  })
})
