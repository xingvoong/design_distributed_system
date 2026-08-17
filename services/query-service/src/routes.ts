import type { PrismaClient } from '@prisma/client'
import type { FastifyInstance } from 'fastify'
import { scatterGather } from './scatter-gather.js'

interface QueryRequestBody {
  query: string
  tenantId: string
  topK?: number
}

interface InferenceClient {
  embed(text: string, tenantId: string): Promise<number[]>
}

export function registerRoutes(
  app: FastifyInstance,
  shards: PrismaClient[],
  inference: InferenceClient,
) {
  app.post<{ Body: QueryRequestBody }>('/query', async (req, reply) => {
    const { query, tenantId, topK = 10 } = req.body

    if (!query || typeof query !== 'string') {
      return reply.code(400).send({ error: 'query must be a non-empty string' })
    }
    if (!tenantId) {
      return reply.code(400).send({ error: 'tenantId is required' })
    }

    const start = Date.now()

    const embedding = await inference.embed(query, tenantId)
    const results = await scatterGather(shards, tenantId, embedding, topK)

    req.log.info(
      { tenantId, shards: shards.length, results: results.length, durationMs: Date.now() - start },
      'query complete',
    )

    return {
      results: results.map((r) => ({
        documentId: r.documentId,
        chunkIndex: r.chunkIndex,
        text: r.text,
        score: r.score,
      })),
      durationMs: Date.now() - start,
    }
  })

  app.get('/healthz', async () => ({ status: 'ok' }))

  app.get('/readyz', async (_req, reply) => {
    if (shards.length === 0) {
      return reply.code(503).send({ status: 'not ready', reason: 'no shards configured' })
    }
    return { status: 'ok', shards: shards.length }
  })
}
