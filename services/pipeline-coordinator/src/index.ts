import { createLeaderElection } from '@docflow/leader-election'
import { createProducer } from '@docflow/queue'
import type { DocumentJob } from '@docflow/types'
import Fastify from 'fastify'
import { Scheduler } from './scheduler.js'

const redisConfig = {
  host: process.env['REDIS_HOST'] ?? 'localhost',
  port: Number(process.env['REDIS_PORT'] ?? 6379),
  ...(process.env['REDIS_PASSWORD'] && { password: process.env['REDIS_PASSWORD'] }),
}

const NODE_ID = process.env['NODE_ID'] ?? `coordinator-${process.pid}`
const HEALTH_PORT = Number(process.env['HEALTH_PORT'] ?? 3002)
const QUEUE_NAME = process.env['QUEUE_NAME'] ?? 'document-jobs'

async function main() {
  // Producer and scheduler created before the HTTP server so the
  // /internal/register route can reference scheduler at call time.
  const producer = createProducer<DocumentJob>({ ...redisConfig, queueName: QUEUE_NAME })
  const scheduler = new Scheduler(producer)

  // Health + registration server
  const app = Fastify({ logger: false })
  app.get('/healthz', async () => ({ status: 'ok', nodeId: NODE_ID }))
  app.get('/readyz', async () => ({ status: 'ok', nodeId: NODE_ID }))

  // Called by the ingest service to register a document for processing.
  // Any coordinator replica accepts registrations — the leader's scheduler
  // picks them up on the next poll tick.
  app.post<{ Body: Omit<DocumentJob, 'source'> & { source: string } }>(
    '/internal/register',
    async (req, reply) => {
      scheduler.enqueue(req.body)
      console.log({ documentId: req.body.documentId, tenantId: req.body.tenantId }, 'document registered')
      return reply.code(202).send({ queued: true })
    },
  )

  await app.listen({ port: HEALTH_PORT, host: '0.0.0.0' })
  console.log({ port: HEALTH_PORT }, 'health server listening')

  // Leader election — only the leader runs the scheduler
  const election = createLeaderElection({
    ...redisConfig,
    electionKey: 'pipeline-coordinator-leader',
    nodeId: NODE_ID,
    ttl: 10_000,
    heartbeatInterval: 3_000,
  })

  election.on('elected', () => {
    console.log({ nodeId: NODE_ID }, 'elected as leader — starting scheduler')
    scheduler.start()
  })

  election.on('revoked', () => {
    console.log({ nodeId: NODE_ID }, 'leadership revoked — stopping scheduler')
    scheduler.stop()
  })

  election.on('follower', () => {
    console.log({ nodeId: NODE_ID }, 'running as follower — standby')
  })

  election.start()

  // Graceful shutdown
  async function shutdown(signal: string) {
    console.log({ signal }, 'shutting down')
    scheduler.stop()
    await election.stop()
    await producer.close()
    await app.close()
    process.exit(0)
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

main().catch((err) => {
  console.error(err, 'coordinator crashed')
  process.exit(1)
})
