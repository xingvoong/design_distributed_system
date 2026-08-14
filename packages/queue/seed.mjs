/**
 * One-shot seeder — pushes a DocumentJob directly into BullMQ.
 * Bypasses the coordinator's in-memory queue so the pipeline is
 * runnable without a real ingest service.
 *
 * Run from services/pipeline-coordinator where bullmq is available
 * as a transitive dep of @docflow/queue.
 */
import { Queue } from 'bullmq'

const REDIS_HOST = process.env['REDIS_HOST'] ?? 'localhost'
const REDIS_PORT = Number(process.env['REDIS_PORT'] ?? 6379)
const QUEUE_NAME = process.env['QUEUE_NAME'] ?? 'document-jobs'

const queue = new Queue(QUEUE_NAME, {
  connection: { host: REDIS_HOST, port: REDIS_PORT },
})

const JOB_OPTS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 1000 },
  removeOnComplete: { count: 1000 },
  removeOnFail: { count: 5000 },
}

const job = await queue.add(
  QUEUE_NAME,
  {
    documentId: 'doc-001',
    tenantId: 'tenant-demo',
    source: '/data/ml-systems.txt',
    mimeType: 'text/plain',
    sizeBytes: 6000,
  },
  JOB_OPTS,
)

console.log(`Seeded job ${job.id} → /data/ml-systems.txt into queue "${QUEUE_NAME}"`)
await queue.close()
