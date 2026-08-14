import type { DocumentChunk } from '@docflow/types'

// OpenAI-compatible APIs accept up to 2048 inputs per request,
// but smaller batches reduce per-request latency and memory pressure.
const MAX_BATCH_SIZE = 96

export function batchChunks(chunks: DocumentChunk[]): DocumentChunk[][] {
  const batches: DocumentChunk[][] = []

  for (let i = 0; i < chunks.length; i += MAX_BATCH_SIZE) {
    batches.push(chunks.slice(i, i + MAX_BATCH_SIZE))
  }

  return batches
}
