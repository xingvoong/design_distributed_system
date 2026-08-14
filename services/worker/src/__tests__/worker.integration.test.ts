/**
 * Phase 2 integration tests — worker pipeline
 *
 * Requires a running Redis instance.
 * Run: docker run -p 6379:6379 redis:7-alpine
 *
 * Spins up a real Node.js HTTP server to stand in for ai-inference.
 * Uses the real queue, real processDocument, and real createInferenceClient.
 * No mocks — every component runs for real.
 */
import { afterEach, beforeAll, afterAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProducer, createConsumer } from '@docflow/queue'
import { createLocalAmbassador } from '@docflow/storage-ambassador'
import type { DocumentJob } from '@docflow/types'
import { processDocument } from '../processor.js'
import { createInferenceClient } from '../inference-client.js'

const REDIS = {
  host: process.env['REDIS_HOST'] ?? 'localhost',
  port: Number(process.env['REDIS_PORT'] ?? 6379),
  queueName: `test-worker-${Date.now()}`,
}

// ─── stub inference server ────────────────────────────────────────────────────

function startStubInferenceServer(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/embed') {
        let body = ''
        req.on('data', (chunk: Buffer) => { body += chunk.toString() })
        req.on('end', () => {
          const { chunks } = JSON.parse(body) as { chunks: unknown[] }
          const embeddings = chunks.map(() => new Array(1536).fill(0))
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ embeddings, provider: 'stub', durationMs: 1 }))
        })
      }
    })
    // Port 0 → OS assigns a free port
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number }
      resolve({ server, url: `http://127.0.0.1:${addr.port}` })
    })
  })
}

// ─── phase 2: processDocument + inference client ──────────────────────────────

describe('processDocument + inference client', () => {
  let inferenceUrl: string
  let server: Server
  let tmpFile: string

  beforeAll(async () => {
    ;({ server, url: inferenceUrl } = await startStubInferenceServer())

    tmpFile = join(tmpdir(), `docflow-test-${Date.now()}.txt`)
    await writeFile(
      tmpFile,
      // Enough text to produce multiple chunks (~512 tokens per chunk, 4 chars/token)
      Array(60)
        .fill('This sentence contributes tokens to the document for chunking purposes.')
        .join(' '),
    )
  })

  afterAll(async () => {
    server.close()
    await rm(tmpFile, { force: true })
  })

  it('processDocument reads a file and returns chunks', async () => {
    const job: DocumentJob = {
      documentId: 'doc-test',
      tenantId: 'tenant-a',
      source: tmpFile,
      mimeType: 'text/plain',
      sizeBytes: 5000,
    }

    const result = await processDocument(job, createLocalAmbassador('/'))
    expect(result.documentId).toBe('doc-test')
    expect(result.chunks.length).toBeGreaterThan(0)
    expect(result.chunks[0]?.text.length).toBeGreaterThan(0)
    expect(result.processingMs).toBeGreaterThanOrEqual(0)
  })

  it('inference client sends chunks and receives embeddings', async () => {
    const job: DocumentJob = {
      documentId: 'doc-test',
      tenantId: 'tenant-a',
      source: tmpFile,
      mimeType: 'text/plain',
      sizeBytes: 5000,
    }

    const result = await processDocument(job, createLocalAmbassador('/'))
    const client = createInferenceClient(inferenceUrl)
    const embeddings = await client.embed(result.chunks, job.tenantId, 'job-1')

    expect(embeddings).toHaveLength(result.chunks.length)
    expect(embeddings[0]).toHaveLength(1536)
  })

  it('full pipeline: file → chunks → embeddings — one embedding per chunk', async () => {
    const job: DocumentJob = {
      documentId: 'doc-e2e',
      tenantId: 'tenant-b',
      source: tmpFile,
      mimeType: 'text/plain',
      sizeBytes: 5000,
    }

    const result = await processDocument(job, createLocalAmbassador('/'))
    const client = createInferenceClient(inferenceUrl)
    const embeddings = await client.embed(result.chunks, job.tenantId, 'job-e2e')

    expect(embeddings.length).toBe(result.chunks.length)
  })
})

// ─── phase 2 + phase 1: queue → worker → inference ───────────────────────────

describe('queue → worker → inference (end-to-end)', () => {
  const cleanups: Array<() => Promise<void>> = []
  let inferenceUrl: string
  let server: Server
  let tmpFile: string

  beforeAll(async () => {
    ;({ server, url: inferenceUrl } = await startStubInferenceServer())

    tmpFile = join(tmpdir(), `docflow-e2e-${Date.now()}.txt`)
    await writeFile(
      tmpFile,
      Array(60)
        .fill('Distributed systems require careful coordination and fault tolerance.')
        .join(' '),
    )
  })

  afterEach(async () => {
    for (const fn of cleanups) await fn()
    cleanups.length = 0
  })

  afterAll(async () => {
    server.close()
    await rm(tmpFile, { force: true })
  })

  it('worker picks up a job, processes it, and gets embeddings', async () => {
    const producer = createProducer<DocumentJob>(REDIS)
    cleanups.push(() => producer.close())

    // Capture what the worker produces
    let resolve!: (v: { chunks: number; embeddings: number }) => void
    const done = new Promise<{ chunks: number; embeddings: number }>((r) => { resolve = r })

    const consumer = createConsumer<DocumentJob>(
      REDIS,
      async (job, jobId) => {
        const result = await processDocument(job, createLocalAmbassador('/'))
        const client = createInferenceClient(inferenceUrl)
        const embeddings = await client.embed(result.chunks, job.tenantId, jobId)
        resolve({ chunks: result.chunks.length, embeddings: embeddings.length })
      },
    )
    consumer.start()
    cleanups.push(() => consumer.stop())

    await producer.add({
      documentId: 'doc-queue',
      tenantId: 'tenant-a',
      source: tmpFile,
      mimeType: 'text/plain',
      sizeBytes: 5000,
    })

    const result = await Promise.race([
      done,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timed out waiting for job')), 10_000),
      ),
    ])

    expect(result.chunks).toBeGreaterThan(0)
    expect(result.embeddings).toBe(result.chunks)
  })
})
