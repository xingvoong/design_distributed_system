import { describe, it, expect, afterEach } from 'vitest'
import { createProducer, createConsumer } from '../index.js'

// These tests require a running Redis instance.
// Run: docker run -p 6379:6379 redis:7-alpine

const config = {
  host: process.env['REDIS_HOST'] ?? 'localhost',
  port: Number(process.env['REDIS_PORT'] ?? 6379),
  queueName: `test-queue-${Date.now()}`,
}

describe('queue', () => {
  const cleanups: Array<() => Promise<void>> = []

  afterEach(async () => {
    for (const cleanup of cleanups) {
      await cleanup()
    }
    cleanups.length = 0
  })

  it('producer adds a job and returns an id', async () => {
    const producer = createProducer(config)
    cleanups.push(() => producer.close())

    const id = await producer.add({ documentId: 'doc-1', tenantId: 'tenant-a' })

    expect(typeof id).toBe('string')
    expect(id.length).toBeGreaterThan(0)
  })

  it('producer addBulk returns one id per job', async () => {
    const producer = createProducer(config)
    cleanups.push(() => producer.close())

    const ids = await producer.addBulk([
      { documentId: 'doc-1', tenantId: 'tenant-a' },
      { documentId: 'doc-2', tenantId: 'tenant-a' },
      { documentId: 'doc-3', tenantId: 'tenant-b' },
    ])

    expect(ids).toHaveLength(3)
    expect(new Set(ids).size).toBe(3) // all ids are unique
  })

  it('consumer processes a job and calls the handler', async () => {
    const producer = createProducer(config)
    cleanups.push(() => producer.close())

    const received: string[] = []

    const consumer = createConsumer<{ documentId: string; tenantId: string }>(
      config,
      async (payload) => {
        received.push(payload.documentId)
      },
    )
    consumer.start()
    cleanups.push(() => consumer.stop())

    await producer.add({ documentId: 'doc-42', tenantId: 'tenant-a' })

    // wait for the worker to pick up and process the job
    await new Promise((resolve) => setTimeout(resolve, 1000))

    expect(received).toContain('doc-42')
  })
})
