import { createConsumer } from '@docflow/queue'
import type { DocumentJob } from '@docflow/types'
import { createHealthServer } from './health.js'
import { processDocument } from './processor.js'

const config = {
  host: process.env['REDIS_HOST'] ?? 'localhost',
  port: Number(process.env['REDIS_PORT'] ?? 6379),
  ...(process.env['REDIS_PASSWORD'] && { password: process.env['REDIS_PASSWORD'] }),
  queueName: process.env['QUEUE_NAME'] ?? 'document-jobs',
}

const HEALTH_PORT = Number(process.env['HEALTH_PORT'] ?? 3001)
const CONCURRENCY = Number(process.env['WORKER_CONCURRENCY'] ?? 5)

async function main() {
  const health = createHealthServer(HEALTH_PORT)
  await health.start()

  const consumer = createConsumer<DocumentJob>(
    config,
    async (job, jobId) => {
      console.log({ jobId, documentId: job.documentId, tenantId: job.tenantId }, 'processing job')

      const result = await processDocument(job)

      console.log(
        {
          jobId,
          documentId: result.documentId,
          chunks: result.chunks.length,
          processingMs: result.processingMs,
        },
        'job complete',
      )

      // Phase 3 picks up here: result.chunks → AI inference → vector store
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
