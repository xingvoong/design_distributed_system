export interface QueueConfig {
  host: string
  port: number
  password?: string
  queueName: string
}

// Marker constraint — any serializable object qualifies.
// Avoids forcing callers to add an index signature to their domain types.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface JobPayload {}

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
