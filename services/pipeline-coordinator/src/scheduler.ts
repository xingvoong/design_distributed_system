import type { Producer } from '@docflow/queue'
import type { DocumentJob } from '@docflow/types'

export interface PendingDocument {
  documentId: string
  tenantId: string
  source: string
  mimeType: DocumentJob['mimeType']
  sizeBytes: number
}

/**
 * Scheduler runs only on the leader node.
 * Polls for pending documents and enqueues them as jobs.
 * In phase 4 this will query Postgres. For now it accepts
 * documents via an in-memory queue so the pipeline is runnable end-to-end.
 */
export class Scheduler {
  private pending: PendingDocument[] = []
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly producer: Producer<DocumentJob>,
    private readonly pollIntervalMs: number = 5_000,
  ) {}

  // Called by the ingest service (phase 4) to register a document for processing
  enqueue(doc: PendingDocument): void {
    this.pending.push(doc)
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.poll(), this.pollIntervalMs)
    console.log({ pollIntervalMs: this.pollIntervalMs }, 'scheduler started')
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    console.log('scheduler stopped')
  }

  private async poll(): Promise<void> {
    if (this.pending.length === 0) return

    const batch = this.pending.splice(0, 50) // process up to 50 per tick

    const jobs: DocumentJob[] = batch.map((doc) => ({
      documentId: doc.documentId,
      tenantId: doc.tenantId,
      source: doc.source,
      mimeType: doc.mimeType,
      sizeBytes: doc.sizeBytes,
    }))

    const ids = await this.producer.addBulk(jobs)
    console.log({ count: ids.length }, 'jobs enqueued')
  }
}
