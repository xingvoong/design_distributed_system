/**
 * Phase 5 integration tests — query service pipeline
 *
 * Requires a running Postgres instance with pgvector extension.
 * Run: docker run -p 5432:5432 -e POSTGRES_USER=docflow -e POSTGRES_PASSWORD=docflow -e POSTGRES_DB=docflow pgvector/pgvector:pg16
 * Then apply migrations: cd packages/db && npx prisma migrate deploy
 *
 * Uses real Postgres for all database operations.
 * The AI inference call is replaced by a stub HTTP server — no external API calls.
 * Every other layer (writeEmbeddedChunks, searchEmbeddedChunks, scatterGather, routes) runs for real.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import Fastify, { type FastifyInstance } from 'fastify'
import { createPrismaClient, writeEmbeddedChunks, searchEmbeddedChunks } from '@docflow/db'
import type { PrismaClient } from '@prisma/client'
import { scatterGather } from '../scatter-gather.js'
import { registerRoutes } from '../routes.js'

const DB_URL =
  process.env['DATABASE_URL'] ?? 'postgresql://docflow:docflow@localhost:5432/docflow'

// Use a fixed tenant so we can clean up between tests without touching other data
const TENANT = 'integration-test-tenant'

// Unit vectors make cosine similarity predictable:
//   vec([1,0,...]) vs vec([1,0,...]) = distance 0   (identical)
//   vec([1,0,...]) vs vec([0,1,...]) = distance 1   (orthogonal)
function unitVec(hotDim: number, dims = 1536): number[] {
  const v = new Array(dims).fill(0) as number[]
  v[hotDim] = 1
  return v
}

// ─── shared setup ─────────────────────────────────────────────────────────────

let prisma: PrismaClient

beforeAll(async () => {
  prisma = createPrismaClient(DB_URL)
  await prisma.$connect()
})

afterAll(async () => {
  await prisma.$disconnect()
})

beforeEach(async () => {
  // Wipe only this tenant's rows so tests don't bleed into each other
  await prisma.$executeRaw`DELETE FROM "EmbeddedChunk" WHERE "tenantId" = ${TENANT}`
})

// ─── layer 1: write + search ──────────────────────────────────────────────────

describe('writeEmbeddedChunks + searchEmbeddedChunks', () => {
  it('finds a chunk after writing it', async () => {
    await writeEmbeddedChunks(prisma, [
      {
        documentId: 'doc-a',
        tenantId: TENANT,
        chunkIndex: 0,
        text: 'hello world',
        tokenCount: 2,
        embedding: unitVec(0),
        embeddingModel: 'test',
      },
    ])

    const results = await searchEmbeddedChunks(prisma, TENANT, unitVec(0), 5)
    expect(results).toHaveLength(1)
    expect(results[0]!.documentId).toBe('doc-a')
    expect(results[0]!.text).toBe('hello world')
  })

  it('ranks the closest chunk first', async () => {
    await writeEmbeddedChunks(prisma, [
      {
        documentId: 'doc-a',
        tenantId: TENANT,
        chunkIndex: 0,
        text: 'chunk on dim 0',
        tokenCount: 3,
        embedding: unitVec(0),
        embeddingModel: 'test',
      },
      {
        documentId: 'doc-b',
        tenantId: TENANT,
        chunkIndex: 0,
        text: 'chunk on dim 1',
        tokenCount: 3,
        embedding: unitVec(1),
        embeddingModel: 'test',
      },
    ])

    // Query vector is on dim 0 → doc-a should be closest (distance ≈ 0)
    const results = await searchEmbeddedChunks(prisma, TENANT, unitVec(0), 5)
    expect(results[0]!.documentId).toBe('doc-a')
    expect(results[1]!.documentId).toBe('doc-b')
    expect(results[0]!.score).toBeLessThan(results[1]!.score)
  })

  it('score is a JS number', async () => {
    await writeEmbeddedChunks(prisma, [
      {
        documentId: 'doc-a',
        tenantId: TENANT,
        chunkIndex: 0,
        text: 'text',
        tokenCount: 1,
        embedding: unitVec(0),
        embeddingModel: 'test',
      },
    ])

    const results = await searchEmbeddedChunks(prisma, TENANT, unitVec(0), 5)
    expect(typeof results[0]!.score).toBe('number')
  })

  it('respects topK limit', async () => {
    await writeEmbeddedChunks(
      prisma,
      Array.from({ length: 10 }, (_, i) => ({
        documentId: `doc-${i}`,
        tenantId: TENANT,
        chunkIndex: 0,
        text: `chunk ${i}`,
        tokenCount: 2,
        embedding: unitVec(i),
        embeddingModel: 'test',
      })),
    )

    const results = await searchEmbeddedChunks(prisma, TENANT, unitVec(0), 3)
    expect(results).toHaveLength(3)
  })

  it('only returns chunks for the queried tenant', async () => {
    await writeEmbeddedChunks(prisma, [
      {
        documentId: 'doc-a',
        tenantId: TENANT,
        chunkIndex: 0,
        text: 'belongs to test tenant',
        tokenCount: 4,
        embedding: unitVec(0),
        embeddingModel: 'test',
      },
      {
        documentId: 'doc-b',
        tenantId: 'other-tenant',
        chunkIndex: 0,
        text: 'belongs to other tenant',
        tokenCount: 4,
        embedding: unitVec(0),
        embeddingModel: 'test',
      },
    ])

    const results = await searchEmbeddedChunks(prisma, TENANT, unitVec(0), 10)
    expect(results.every((r) => r.tenantId === TENANT)).toBe(true)
    expect(results).toHaveLength(1)
  })

  it('returns empty array when no chunks exist for tenant', async () => {
    const results = await searchEmbeddedChunks(prisma, TENANT, unitVec(0), 10)
    expect(results).toEqual([])
  })
})

// ─── layer 2: scatterGather ───────────────────────────────────────────────────

describe('scatterGather with real shards', () => {
  it('returns results from a single real shard', async () => {
    await writeEmbeddedChunks(prisma, [
      {
        documentId: 'doc-a',
        tenantId: TENANT,
        chunkIndex: 0,
        text: 'scatter test',
        tokenCount: 2,
        embedding: unitVec(0),
        embeddingModel: 'test',
      },
    ])

    const results = await scatterGather([prisma], TENANT, unitVec(0), 5)
    expect(results).toHaveLength(1)
    expect(results[0]!.documentId).toBe('doc-a')
    expect(results[0]!.shardIndex).toBe(0)
  })

  it('merges and re-ranks results from two shards pointing at the same DB', async () => {
    // Two clients, same DB — simulates two shards with overlapping data.
    // In production shards would have disjoint data; here we verify the
    // merge and re-rank logic runs correctly against real Postgres.
    const shard0 = createPrismaClient(DB_URL)
    const shard1 = createPrismaClient(DB_URL)

    try {
      await writeEmbeddedChunks(prisma, [
        {
          documentId: 'doc-close',
          tenantId: TENANT,
          chunkIndex: 0,
          text: 'close to query',
          tokenCount: 3,
          embedding: unitVec(0),
          embeddingModel: 'test',
        },
        {
          documentId: 'doc-far',
          tenantId: TENANT,
          chunkIndex: 0,
          text: 'far from query',
          tokenCount: 3,
          embedding: unitVec(1),
          embeddingModel: 'test',
        },
      ])

      // topK=1 per shard means each returns its best. After global re-rank,
      // doc-close should be first regardless of shard order.
      const results = await scatterGather([shard0, shard1], TENANT, unitVec(0), 1)

      expect(results).toHaveLength(1)
      expect(results[0]!.documentId).toBe('doc-close')
    } finally {
      await shard0.$disconnect()
      await shard1.$disconnect()
    }
  })
})

// ─── layer 3: full HTTP route ─────────────────────────────────────────────────

/**
 * Starts a stub inference server that returns a fixed embedding vector.
 * The query service calls this instead of the real ai-inference service.
 */
function startStubInference(embedding: number[]): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/embed') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ embeddings: [embedding], provider: 'stub', durationMs: 1 }))
      }
    })
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number }
      resolve({ server, url: `http://127.0.0.1:${addr.port}` })
    })
  })
}

describe('POST /query — full HTTP route', () => {
  let app: FastifyInstance
  let inferenceServer: Server
  let inferenceUrl: string

  beforeAll(async () => {
    // Stub inference always returns a vector on dim 0
    ;({ server: inferenceServer, url: inferenceUrl } = await startStubInference(unitVec(0)))

    const inference = {
      async embed(_text: string, _tenantId: string): Promise<number[]> {
        const res = await fetch(`${inferenceUrl}/embed`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chunks: [{ text: _text, index: 0 }], tenantId: _tenantId, jobId: 'query' }),
        })
        const body = (await res.json()) as { embeddings: number[][] }
        return body.embeddings[0]!
      },
    }

    app = Fastify({ logger: false })
    registerRoutes(app, [prisma], inference)
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
    inferenceServer.close()
  })

  it('returns ranked results for a query', async () => {
    await writeEmbeddedChunks(prisma, [
      {
        documentId: 'doc-best',
        tenantId: TENANT,
        chunkIndex: 0,
        text: 'the best match',
        tokenCount: 3,
        embedding: unitVec(0),  // matches the stub inference vector exactly
        embeddingModel: 'test',
      },
      {
        documentId: 'doc-worst',
        tenantId: TENANT,
        chunkIndex: 0,
        text: 'a poor match',
        tokenCount: 3,
        embedding: unitVec(1),  // orthogonal to the query vector
        embeddingModel: 'test',
      },
    ])

    const res = await app.inject({
      method: 'POST',
      url: '/query',
      payload: { query: 'best match', tenantId: TENANT, topK: 5 },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json<{ results: Array<{ documentId: string; score: number }> }>()
    expect(body.results.length).toBeGreaterThan(0)
    expect(body.results[0]!.documentId).toBe('doc-best')
    expect(body.results[0]!.score).toBeLessThan(body.results[1]!.score)
  })

  it('returns 200 with empty results when no chunks match the tenant', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/query',
      payload: { query: 'anything', tenantId: 'unknown-tenant', topK: 5 },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json<{ results: unknown[] }>().results).toEqual([])
  })

  it('returns durationMs', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/query',
      payload: { query: 'test', tenantId: TENANT },
    })

    expect(typeof res.json<{ durationMs: number }>().durationMs).toBe('number')
  })
})
