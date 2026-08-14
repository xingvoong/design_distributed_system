export interface QueueConfig {
  host: string
  port: number
  password?: string
  queueName: string
}

export interface JobPayload {
  [key: string]: unknown
}

export interface JobOptions {
  priority?: number
  delay?: number
  attempts?: number
  backoff?: {
    type: 'fixed' | 'exponential'
    delay: number
  }
}

export type JobHandler<T extends JobPayload> = (
  payload: T,
  jobId: string,
) => Promise<void>

export interface Producer<T extends JobPayload> {
  add(payload: T, options?: JobOptions): Promise<string>
  addBulk(payloads: T[], options?: JobOptions): Promise<string[]>
  close(): Promise<void>
}

export interface Consumer<T extends JobPayload> {
  start(): void
  stop(): Promise<void>
}
