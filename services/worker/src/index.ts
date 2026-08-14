import { createPrismaClient, writeEmbeddedChunks } from '@docflow/db'
import { createConsumer } from '@docflow/queue'
import { createLocalAmbassador } from '@docflow/storage-ambassador'
import type { DocumentJob } from '@docflow/types'
import { createHealthServer } from './health.js'
import { createInferenceClient } from './inference-client.js'
import { processDocument } from './processor.js'

const config = {
  host: process.env['REDIS_HOST'] ?? 'localhost',
  port: Number(process.env['REDIS_PORT'] ?? 6379),
  ...(process.env['REDIS_PASSWORD'] && { password: process.env['REDIS_PASSWORD'] }),
  queueName: process.env['QUEUE_NAME'] ?? 'document-jobs',
}

const HEALTH_PORT = Number(process.env['HEALTH_PORT'] ?? 3001)
const CONCURRENCY = Number(process.env['WORKER_CONCURRENCY'] ?? 5)
const INFERENCE_URL = process.env['INFERENCE_URL'] ?? 'http://localhost:3003'
const STORAGE_BASE = process.env['STORAGE_BASE'] ?? '/'

const EMBEDDING_MODEL = process.env['EMBEDDING_MODEL'] ?? 'text-embedding-3-small'

async function main() {
  const health = createHealthServer(HEALTH_PORT)
  await health.start()

  const db = createPrismaClient()
  const storage = createLocalAmbassador(STORAGE_BASE)
  const inference = createInferenceClient(INFERENCE_URL)

  const consumer = createConsumer<DocumentJob>(
    config,
    async (job, jobId) => {
      console.log({ jobId, documentId: job.documentId, tenantId: job.tenantId }, 'processing job')

      const result = await processDocument(job, storage)
      const embeddings = await inference.embed(result.chunks, job.tenantId, jobId)

      await writeEmbeddedChunks(
        db,
        result.chunks.map((chunk, i) => ({
          ...chunk,
          embedding: embeddings[i] ?? [],
          embeddingModel: EMBEDDING_MODEL,
        })),
      )

      console.log(
        {
          jobId,
          documentId: result.documentId,
          chunks: result.chunks.length,
          processingMs: result.processingMs,
        },
        'embeddings written to pgvector',
      )
    },
    CONCURRENCY,
  )

  consumer.start()
  health.setReady(true)
  console.log({ concurrency: CONCURRENCY, queue: config.queueName }, 'worker running')

  // Graceful shutdown — finish in-flight jobs before exit
  async function shutdown(signal: string) {
    console.log({ signal }, 'shutting down')
    health.setReady(false)
    await consumer.stop()
    await health.stop()
    process.exit(0)
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

main().catch((err) => {
  console.error(err, 'worker crashed')
  process.exit(1)
})
