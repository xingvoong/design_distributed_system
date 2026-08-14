/**
 * Phase 3 integration tests — ai-inference service
 *
 * Uses the real Fastify app wired to a real AIAdapter. No mocks.
 * The stub provider replaces the HTTP embedding API so no external
 * calls are made, but every other layer (adapter, circuit breaker,
 * batcher, routes) runs for real.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { createAIAdapter, createStubProvider } from '@docflow/ai-adapter'
import type { EmbeddingProvider } from '@docflow/ai-adapter'
import type { DocumentChunk } from '@docflow/types'
import { registerRoutes } from '../routes.js'

function makeChunk(index: number, text = `sentence number ${index}.`): DocumentChunk {
  return { documentId: 'doc-1', tenantId: 'tenant-a', chunkIndex: index, text, tokenCount: 10 }
}

function buildApp(primary: EmbeddingProvider, failureThreshold = 5): FastifyInstance {
  const adapter = createAIAdapter({
    primary,
    fallback: createStubProvider(),
    circuitBreaker: { failureThreshold, cooldownMs: 60_000 },
  })
  const app = Fastify({ logger: false })
  registerRoutes(app, adapter)
  return app
}

// ─── happy path ───────────────────────────────────────────────────────────────

describe('POST /embed — happy path', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = buildApp(createStubProvider())
    await app.ready()
  })

  afterAll(() => app.close())

  it('returns one embedding per chunk', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/embed',
      payload: { chunks: [makeChunk(0), makeChunk(1), makeChunk(2)], tenantId: 'tenant-a', jobId: 'j1' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json<{ embeddings: number[][] }>().embeddings).toHaveLength(3)
  })

  it('each embedding has 1536 dimensions', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/embed',
      payload: { chunks: [makeChunk(0)], tenantId: 'tenant-a', jobId: 'j2' },
    })
    const { embeddings } = res.json<{ embeddings: number[][] }>()
    expect(embeddings[0]).toHaveLength(1536)
  })

  it('handles 200 chunks across three batches (≤96 each)', async () => {
    const chunks = Array.from({ length: 200 }, (_, i) => makeChunk(i))
    const res = await app.inject({
      method: 'POST',
      url: '/embed',
      payload: { chunks, tenantId: 'tenant-a', jobId: 'j3' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json<{ embeddings: number[][] }>().embeddings).toHaveLength(200)
  })

  it('returns durationMs and provider', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/embed',
      payload: { chunks: [makeChunk(0)], tenantId: 'tenant-a', jobId: 'j4' },
    })
    const body = res.json<{ provider: string; durationMs: number }>()
    expect(typeof body.provider).toBe('string')
    expect(body.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('rejects empty chunks with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/embed',
      payload: { chunks: [], tenantId: 'tenant-a', jobId: 'j5' },
    })
    expect(res.statusCode).toBe(400)
  })
})

// ─── circuit breaker ──────────────────────────────────────────────────────────

describe('circuit breaker integration', () => {
  const failingProvider: EmbeddingProvider = {
    name: 'failing',
    async embed() { throw new Error('provider down') },
  }

  it('falls back to stub after primary fails', async () => {
    const app = buildApp(failingProvider, 1)
    await app.ready()
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/embed',
        payload: { chunks: [makeChunk(0)], tenantId: 'tenant-a', jobId: 'j1' },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json<{ provider: string }>().provider).toBe('stub')
    } finally {
      await app.close()
    }
  })

  it('/readyz returns 503 once circuit is OPEN', async () => {
    const app = buildApp(failingProvider, 1)
    await app.ready()
    try {
      // First request trips the circuit (threshold=1)
      await app.inject({
        method: 'POST',
        url: '/embed',
        payload: { chunks: [makeChunk(0)], tenantId: 'tenant-a', jobId: 'trip' },
      })

      const res = await app.inject({ method: 'GET', url: '/readyz' })
      expect(res.statusCode).toBe(503)
      expect(res.json<{ circuitState: string }>().circuitState).toBe('OPEN')
    } finally {
      await app.close()
    }
  })

  it('/readyz returns 200 with working provider', async () => {
    const app = buildApp(createStubProvider())
    await app.ready()
    try {
      const res = await app.inject({ method: 'GET', url: '/readyz' })
      expect(res.statusCode).toBe(200)
    } finally {
      await app.close()
    }
  })
})

// ─── health ───────────────────────────────────────────────────────────────────

describe('health endpoints', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = buildApp(createStubProvider())
    await app.ready()
  })

  afterAll(() => app.close())

  it('/healthz always returns 200', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ status: 'ok' })
  })
})
