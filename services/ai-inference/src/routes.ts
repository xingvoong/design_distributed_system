import type { AIAdapter } from '@docflow/ai-adapter'
import type { DocumentChunk } from '@docflow/types'
import type { FastifyInstance } from 'fastify'
import { batchChunks } from './batcher.js'

interface EmbedRequestBody {
  chunks: DocumentChunk[]
  tenantId: string
  jobId: string
}

export function registerRoutes(app: FastifyInstance, adapter: AIAdapter) {
  app.post<{ Body: EmbedRequestBody }>('/embed', async (req, reply) => {
    const { chunks, tenantId, jobId } = req.body

    if (!chunks || chunks.length === 0) {
      return reply.code(400).send({ error: 'chunks must be a non-empty array' })
    }

    const batches = batchChunks(chunks)
    const allEmbeddings: number[][] = []
    let provider = ''
    let totalDurationMs = 0

    for (const batch of batches) {
      const texts = batch.map((c) => c.text)
      const result = await adapter.embed(texts)
      allEmbeddings.push(...result.embeddings)
      provider = result.provider
      totalDurationMs += result.durationMs
    }

    req.log.info({ jobId, tenantId, chunks: chunks.length, batches: batches.length, provider }, 'embedded')

    return {
      embeddings: allEmbeddings,
      provider,
      durationMs: totalDurationMs,
    }
  })

  app.get('/healthz', async () => ({ status: 'ok' }))

  app.get('/readyz', async (_req, reply) => {
    const state = adapter.circuitState()
    if (state === 'OPEN') {
      return reply.code(503).send({ status: 'not ready', circuitState: state })
    }
    return { status: 'ok', circuitState: state }
  })
}
