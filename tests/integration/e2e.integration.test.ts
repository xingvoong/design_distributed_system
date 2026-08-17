/**
 * End-to-end integration test — Phase 1 through Phase 5
 *
 * Requires:
 *   Redis:    docker run -p 6379:6379 redis:7-alpine
 *   Postgres: docker run -p 5432:5432 -e POSTGRES_USER=docflow -e POSTGRES_PASSWORD=docflow -e POSTGRES_DB=docflow pgvector/pgvector:pg16
 *   Migrate:  cd packages/db && DATABASE_URL=postgresql://docflow:docflow@localhost:5432/docflow npx prisma migrate deploy
 *
 * Full pipeline under test:
 *
 *   [Phase 1] producer.add(job) → Redis queue
 *   [Phase 1] consumer picks up job
 *   [Phase 2] processDocument() → reads file, chunks text
 *   [Phase 3] stub inference server → returns embeddings (no real API calls)
 *   [Phase 4] writeEmbeddedChunks() → writes vectors to pgvector
 *   [Phase 5] scatterGather() → finds the chunks by similarity
 *
 * No mocks. Every layer except the external AI API runs for real.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProducer, createConsumer } from '@docflow/queue'
import { createPrismaClient, writeEmbeddedChunks, searchEmbeddedChunks } from '@docflow/db'
import { createLocalAmbassador } from '@docflow/storage-ambassador'
import type { DocumentJob } from '@docflow/types'
import type { PrismaClient } from '@prisma/client'
import { processDocument } from '../../services/worker/src/processor.js'
import { createInferenceClient } from '../../services/worker/src/inference-client.js'
import { scatterGather } from '../../services/query-service/src/scatter-gather.js'

// ─── config ───────────────────────────────────────────────────────────────────

const REDIS = {
  host: process.env['REDIS_HOST'] ?? 'localhost',
  port: Number(process.env['REDIS_PORT'] ?? 6379),
  queueName: `e2e-test-${Date.now()}`,
}

const DB_URL =
  process.env['DATABASE_URL'] ?? 'postgresql://docflow:docflow@localhost:5432/docflow'

const TENANT = 'e2e-test-tenant'
const EMBEDDING_MODEL = 'stub'

// A fixed non-zero vector used by the stub inference server.
// All chunks get this embedding, so any search with the same vector
// returns them all with distance ≈ 0.
const STUB_EMBEDDING = new Array(1536).fill(0.1) as number[]

// ─── shared infrastructure ────────────────────────────────────────────────────

let prisma: PrismaClient
let inferenceServer: Server
let inferenceUrl: string
let tmpFile: string

/**
 * Starts a stub inference server that returns a fixed embedding for every chunk.
 * Stands in for ai-inference (Phase 3) without hitting a real AI provider.
 */
function startStubInference(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/embed') {
        let body = ''
        req.on('data', (chunk: Buffer) => { body += chunk.toString() })
        req.on('end', () => {
          const { chunks } = JSON.parse(body) as { chunks: unknown[] }
          const embeddings = chunks.map(() => STUB_EMBEDDING)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ embeddings, provider: 'stub', durationMs: 1 }))
        })
      }
    })
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number }
      resolve({ server, url: `http://127.0.0.1:${addr.port}` })
    })
  })
}

beforeAll(async () => {
  prisma = createPrismaClient(DB_URL)
  await prisma.$connect()
  ;({ server: inferenceServer, url: inferenceUrl } = await startStubInference())

  // A file with enough text to produce at least a few chunks
  tmpFile = join(tmpdir(), `docflow-e2e-${Date.now()}.txt`)
  await writeFile(
    tmpFile,
    Array(80)
      .fill('Distributed systems require careful design for fault tolerance and scalability.')
      .join(' '),
  )
})

afterAll(async () => {
  inferenceServer.close()
  await prisma.$disconnect()
  await rm(tmpFile, { force: true })
})

beforeEach(async () => {
  await prisma.$executeRaw`DELETE FROM "EmbeddedChunk" WHERE "tenantId" = ${TENANT}`
})

// ─── tests ────────────────────────────────────────────────────────────────────

describe('Phase 1–5 end-to-end pipeline', () => {
  it('document queued → worker processes → embeddings in pgvector → query finds it', async () => {
    const storage = createLocalAmbassador('/')
    const inference = createInferenceClient(inferenceUrl)

    // Track how many chunks the worker wrote so we can assert on it
    let chunksWritten = 0
    let jobDone!: () => void
    const jobComplete = new Promise<void>((resolve) => { jobDone = resolve })

    // [Phase 1] Consumer — replicates the worker pipeline from services/worker/src/index.ts
    const consumer = createConsumer<DocumentJob>(
      REDIS,
      async (job, jobId) => {
        // [Phase 2] chunk the document
        const result = await processDocument(job, storage)

        // [Phase 3] embed via stub inference server
        const embeddings = await inference.embed(result.chunks, job.tenantId, jobId)

        // [Phase 4] write to pgvector
        await writeEmbeddedChunks(
          prisma,
          result.chunks.map((chunk, i) => ({
            ...chunk,
            embedding: embeddings[i] ?? [],
            embeddingModel: EMBEDDING_MODEL,
          })),
        )

        chunksWritten = result.chunks.length
        jobDone()
      },
    )
    consumer.start()

    // [Phase 1] Producer — queues the document job
    const producer = createProducer<DocumentJob>(REDIS)
    await producer.add({
      documentId: 'e2e-doc-1',
      tenantId: TENANT,
      source: tmpFile,
      mimeType: 'text/plain',
      sizeBytes: 10_000,
    })

    // Wait for the worker to finish, with a 15s timeout
    await Promise.race([
      jobComplete,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timed out waiting for worker')), 15_000),
      ),
    ])

    await consumer.stop()
    await producer.close()

    // [Phase 5] scatterGather — find the chunks we just wrote
    const results = await scatterGather([prisma], TENANT, STUB_EMBEDDING, 10)

    expect(chunksWritten).toBeGreaterThan(0)
    expect(results.length).toBeGreaterThan(0)
    expect(results.length).toBeLessThanOrEqual(chunksWritten)
    expect(results[0]!.tenantId).toBe(TENANT)
    expect(results[0]!.documentId).toBe('e2e-doc-1')
    // All chunks got the same stub embedding so scores should be near 0
    expect(results[0]!.score).toBeLessThan(0.01)
  })

  it('two documents queued — query returns chunks from both', async () => {
    const storage = createLocalAmbassador('/')
    const inference = createInferenceClient(inferenceUrl)

    let jobsCompleted = 0
    let allDone!: () => void
    const bothComplete = new Promise<void>((resolve) => { allDone = resolve })

    const consumer = createConsumer<DocumentJob>(
      REDIS,
      async (job, jobId) => {
        const result = await processDocument(job, storage)
        const embeddings = await inference.embed(result.chunks, job.tenantId, jobId)
        await writeEmbeddedChunks(
          prisma,
          result.chunks.map((chunk, i) => ({
            ...chunk,
            embedding: embeddings[i] ?? [],
            embeddingModel: EMBEDDING_MODEL,
          })),
        )
        jobsCompleted++
        if (jobsCompleted === 2) allDone()
      },
    )
    consumer.start()

    const producer = createProducer<DocumentJob>(REDIS)
    await producer.addBulk([
      {
        documentId: 'e2e-doc-a',
        tenantId: TENANT,
        source: tmpFile,
        mimeType: 'text/plain',
        sizeBytes: 10_000,
      },
      {
        documentId: 'e2e-doc-b',
        tenantId: TENANT,
        source: tmpFile,
        mimeType: 'text/plain',
        sizeBytes: 10_000,
      },
    ])

    await Promise.race([
      bothComplete,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timed out waiting for both jobs')), 20_000),
      ),
    ])

    await consumer.stop()
    await producer.close()

    // Both documents should be searchable
    const results = await scatterGather([prisma], TENANT, STUB_EMBEDDING, 50)
    const docIds = new Set(results.map((r) => r.documentId))

    expect(docIds.has('e2e-doc-a')).toBe(true)
    expect(docIds.has('e2e-doc-b')).toBe(true)
  })

  it('tenant isolation — query only returns the querying tenant\'s documents', async () => {
    const OTHER_TENANT = 'e2e-other-tenant'

    // Write a chunk for a different tenant directly
    await writeEmbeddedChunks(prisma, [
      {
        documentId: 'other-doc',
        tenantId: OTHER_TENANT,
        chunkIndex: 0,
        text: 'this belongs to another tenant',
        tokenCount: 6,
        embedding: STUB_EMBEDDING,
        embeddingModel: EMBEDDING_MODEL,
      },
    ])

    // Also write a chunk for the test tenant directly
    await writeEmbeddedChunks(prisma, [
      {
        documentId: 'my-doc',
        tenantId: TENANT,
        chunkIndex: 0,
        text: 'this belongs to the test tenant',
        tokenCount: 6,
        embedding: STUB_EMBEDDING,
        embeddingModel: EMBEDDING_MODEL,
      },
    ])

    const results = await scatterGather([prisma], TENANT, STUB_EMBEDDING, 10)

    expect(results.every((r) => r.tenantId === TENANT)).toBe(true)
    expect(results.some((r) => r.documentId === 'my-doc')).toBe(true)
    expect(results.some((r) => r.documentId === 'other-doc')).toBe(false)

    // Clean up other tenant
    await prisma.$executeRaw`DELETE FROM "EmbeddedChunk" WHERE "tenantId" = ${OTHER_TENANT}`
  })

  it('searchEmbeddedChunks returns no results before any jobs are processed', async () => {
    const results = await searchEmbeddedChunks(prisma, TENANT, STUB_EMBEDDING, 10)
    expect(results).toEqual([])
  })
})
