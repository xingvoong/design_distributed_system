import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import type { PrismaClient } from '@prisma/client'
import { registerRoutes } from '../routes.js'
import type { ChunkSearchResult } from '@docflow/db'

function makeShard(results: ChunkSearchResult[] = []): PrismaClient {
  return {
    $queryRaw: vi.fn().mockResolvedValue(results),
  } as unknown as PrismaClient
}

function makeResult(overrides: Partial<ChunkSearchResult> = {}): ChunkSearchResult {
  return {
    id: 'chunk-1',
    documentId: 'doc-1',
    tenantId: 'tenant-a',
    chunkIndex: 0,
    text: 'relevant text about the topic',
    score: 0.15,
    ...overrides,
  }
}

const QUERY_VEC = new Array(1536).fill(0.1) as number[]

const stubInference = {
  embed: vi.fn().mockResolvedValue(QUERY_VEC),
}

describe('POST /query', () => {
  let app: FastifyInstance

  beforeEach(() => {
    app = Fastify({ logger: false })
    vi.clearAllMocks()
  })

  afterEach(async () => {
    await app.close()
  })

  it('returns ranked results for a valid request', async () => {
    const shard = makeShard([
      makeResult({ id: 'a', score: 0.1, text: 'best match' }),
      makeResult({ id: 'b', score: 0.4, text: 'second match' }),
    ])
    registerRoutes(app, [shard], stubInference)

    const res = await app.inject({
      method: 'POST',
      url: '/query',
      payload: { query: 'machine learning', tenantId: 'tenant-a', topK: 5 },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json<{ results: Array<{ documentId: string; score: number; text: string }> }>()
    expect(body.results).toHaveLength(2)
    expect(body.results[0]!.score).toBeLessThan(body.results[1]!.score)
  })

  it('includes documentId, chunkIndex, text, and score in each result', async () => {
    const shard = makeShard([makeResult({ documentId: 'doc-42', chunkIndex: 3, score: 0.2 })])
    registerRoutes(app, [shard], stubInference)

    const res = await app.inject({
      method: 'POST',
      url: '/query',
      payload: { query: 'some query', tenantId: 'tenant-a' },
    })

    const result = res.json<{ results: Array<Record<string, unknown>> }>().results[0]!
    expect(result).toMatchObject({
      documentId: 'doc-42',
      chunkIndex: 3,
      score: 0.2,
      text: expect.any(String),
    })
    // shardIndex is internal — should not leak into the response
    expect(result).not.toHaveProperty('shardIndex')
  })

  it('includes durationMs in the response', async () => {
    registerRoutes(app, [makeShard()], stubInference)

    const res = await app.inject({
      method: 'POST',
      url: '/query',
      payload: { query: 'test', tenantId: 'tenant-a' },
    })

    expect(res.json<{ durationMs: number }>().durationMs).toBeGreaterThanOrEqual(0)
  })

  it('defaults topK to 10 when not provided', async () => {
    const results = Array.from({ length: 20 }, (_, i) =>
      makeResult({ id: `chunk-${i}`, score: i * 0.05 }),
    )
    const shard = makeShard(results)
    registerRoutes(app, [shard], stubInference)

    const res = await app.inject({
      method: 'POST',
      url: '/query',
      payload: { query: 'test', tenantId: 'tenant-a' },
    })

    // Shard returns 20, but scatterGather caps at topK=10 by default
    expect(res.json<{ results: unknown[] }>().results.length).toBeLessThanOrEqual(10)
  })

  it('calls inference with the query text', async () => {
    registerRoutes(app, [makeShard()], stubInference)

    await app.inject({
      method: 'POST',
      url: '/query',
      payload: { query: 'what is a transformer', tenantId: 'tenant-a' },
    })

    expect(stubInference.embed).toHaveBeenCalledWith('what is a transformer', 'tenant-a')
  })

  it('returns 400 when query is missing', async () => {
    registerRoutes(app, [makeShard()], stubInference)

    const res = await app.inject({
      method: 'POST',
      url: '/query',
      payload: { tenantId: 'tenant-a' },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: 'query must be a non-empty string' })
  })

  it('returns 400 when query is empty string', async () => {
    registerRoutes(app, [makeShard()], stubInference)

    const res = await app.inject({
      method: 'POST',
      url: '/query',
      payload: { query: '', tenantId: 'tenant-a' },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: 'query must be a non-empty string' })
  })

  it('returns 400 when tenantId is missing', async () => {
    registerRoutes(app, [makeShard()], stubInference)

    const res = await app.inject({
      method: 'POST',
      url: '/query',
      payload: { query: 'some query' },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: 'tenantId is required' })
  })

  it('returns empty results when no chunks match', async () => {
    registerRoutes(app, [makeShard([])], stubInference)

    const res = await app.inject({
      method: 'POST',
      url: '/query',
      payload: { query: 'obscure query', tenantId: 'tenant-a' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json<{ results: unknown[] }>().results).toEqual([])
  })
})

describe('GET /healthz', () => {
  let app: FastifyInstance

  beforeEach(() => {
    app = Fastify({ logger: false })
  })

  afterEach(async () => {
    await app.close()
  })

  it('always returns 200', async () => {
    registerRoutes(app, [makeShard()], stubInference)

    const res = await app.inject({ method: 'GET', url: '/healthz' })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ status: 'ok' })
  })
})

describe('GET /readyz', () => {
  let app: FastifyInstance

  beforeEach(() => {
    app = Fastify({ logger: false })
  })

  afterEach(async () => {
    await app.close()
  })

  it('returns 200 with shard count when shards are configured', async () => {
    registerRoutes(app, [makeShard(), makeShard()], stubInference)

    const res = await app.inject({ method: 'GET', url: '/readyz' })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ status: 'ok', shards: 2 })
  })

  it('returns 503 when no shards are configured', async () => {
    registerRoutes(app, [], stubInference)

    const res = await app.inject({ method: 'GET', url: '/readyz' })

    expect(res.statusCode).toBe(503)
    expect(res.json()).toMatchObject({ status: 'not ready' })
  })
})
