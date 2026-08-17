import { createPrismaClient } from '@docflow/db'
import Fastify from 'fastify'
import { registerRoutes } from './routes.js'

const PORT = Number(process.env['PORT'] ?? 3005)
const INFERENCE_URL = process.env['INFERENCE_URL'] ?? 'http://localhost:3003'

/**
 * SHARD_URLS is a comma-separated list of Postgres connection strings,
 * one per shard. A single URL means one shard — still works correctly.
 * Example: postgres://user:pass@shard0/db,postgres://user:pass@shard1/db
 */
const SHARD_URLS = (process.env['SHARD_URLS'] ?? process.env['DATABASE_URL'] ?? '').split(',').filter(Boolean)

if (SHARD_URLS.length === 0) {
  console.error('SHARD_URLS or DATABASE_URL is required')
  process.exit(1)
}

/**
 * Thin client that calls the ai-inference /embed endpoint.
 * Query service never manages its own AI connection or circuit breaker —
 * that's ai-inference's job.
 */
const inference = {
  async embed(text: string, tenantId: string): Promise<number[]> {
    const res = await fetch(`${INFERENCE_URL}/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chunks: [{ text, index: 0 }],
        tenantId,
        jobId: 'query',
      }),
    })

    if (!res.ok) {
      throw new Error(`ai-inference returned ${res.status}`)
    }

    const body = (await res.json()) as { embeddings: number[][] }
    const embedding = body.embeddings[0]
    if (!embedding) throw new Error('ai-inference returned no embeddings')
    return embedding
  },
}

async function main() {
  const shards = SHARD_URLS.map((url, i) => {
    console.log({ shardIndex: i }, 'connecting to shard')
    return createPrismaClient(url)
  })

  const app = Fastify({ logger: true })
  registerRoutes(app, shards, inference)

  await app.listen({ port: PORT, host: '0.0.0.0' })
  console.log({ port: PORT, shards: shards.length }, 'query-service listening')

  async function shutdown(signal: string) {
    console.log({ signal }, 'shutting down')
    await app.close()
    await Promise.all(shards.map((s) => s.$disconnect()))
    process.exit(0)
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

main().catch((err) => {
  console.error(err, 'query-service crashed')
  process.exit(1)
})
