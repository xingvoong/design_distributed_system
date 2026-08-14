import { Worker } from 'bullmq'
import { Redis } from 'ioredis'
import type { Consumer, JobHandler, JobPayload, QueueConfig } from './types.js'

export function createConsumer<T extends JobPayload>(
  config: QueueConfig,
  handler: JobHandler<T>,
  concurrency = 5,
): Consumer<T> {
  const connection = new Redis({
    host: config.host,
    port: config.port,
    password: config.password,
    maxRetriesPerRequest: null,
  })

  const worker = new Worker<T>(
    config.queueName,
    async (job) => {
      await handler(job.data, job.id ?? 'unknown')
    },
    {
      connection,
      concurrency,
      // drain in-flight jobs before shutdown
      lockDuration: 30_000,
    },
  )

  worker.on('failed', (job, err) => {
    console.error({ jobId: job?.id, queue: config.queueName, err }, 'job failed')
  })

  return {
    start() {
      // worker starts automatically on creation — this is explicit signal
      console.log({ queue: config.queueName, concurrency }, 'consumer started')
    },

    async stop() {
      // closes after active jobs finish, does not abandon in-flight work
      await worker.close()
      await connection.quit()
      console.log({ queue: config.queueName }, 'consumer stopped gracefully')
    },
  }
}
