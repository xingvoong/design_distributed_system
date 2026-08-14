import { Queue } from 'bullmq'
import { Redis } from 'ioredis'
import type { JobOptions, JobPayload, Producer, QueueConfig } from './types.js'

export function createProducer<T extends JobPayload>(
  config: QueueConfig,
): Producer<T> {
  const connection = new Redis({
    host: config.host,
    port: config.port,
    password: config.password,
    maxRetriesPerRequest: null,
  })

  // BullMQ's internal generics don't compose well with our JobPayload constraint.
  // Type safety is enforced at the Producer<T> interface boundary instead.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const queue = new Queue<any>(config.queueName, { connection })

  function buildOpts(options: JobOptions) {
    return {
      ...(options.priority !== undefined && { priority: options.priority }),
      ...(options.delay !== undefined && { delay: options.delay }),
      attempts: options.attempts ?? 3,
      backoff: options.backoff ?? { type: 'exponential' as const, delay: 1000 },
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 5000 },
    }
  }

  return {
    async add(payload: T, options: JobOptions = {}): Promise<string> {
      const job = await queue.add(config.queueName, payload, buildOpts(options))
      if (!job.id) throw new Error('Job created without an id')
      return job.id
    },

    async addBulk(payloads: T[], options: JobOptions = {}): Promise<string[]> {
      const jobs = await queue.addBulk(
        payloads.map((payload) => ({
          name: config.queueName,
          data: payload,
          opts: buildOpts(options),
        })),
      )
      return jobs.map((job) => {
        if (!job.id) throw new Error('Bulk job created without an id')
        return job.id
      })
    },

    async close(): Promise<void> {
      await queue.close()
      await connection.quit()
    },
  }
}
