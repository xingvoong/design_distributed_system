import type { DocumentChunk } from '@docflow/types'

const CHUNK_SIZE = 512        // target tokens per chunk
const CHUNK_OVERLAP = 64      // tokens shared between adjacent chunks
const AVG_CHARS_PER_TOKEN = 4 // rough approximation

function estimateTokens(text: string): number {
  return Math.ceil(text.length / AVG_CHARS_PER_TOKEN)
}

/**
 * Splits text into overlapping chunks.
 * Splits on sentence boundaries where possible to avoid cutting mid-thought.
 */
export function chunkText(
  text: string,
  documentId: string,
  tenantId: string,
): DocumentChunk[] {
  const sentences = text
    .replace(/\r\n/g, '\n')
    .split(/(?<=[.!?])\s+/)
    .filter((s) => s.trim().length > 0)

  const chunks: DocumentChunk[] = []
  let buffer: string[] = []
  let bufferTokens = 0
  let chunkIndex = 0

  for (const sentence of sentences) {
    const sentenceTokens = estimateTokens(sentence)

    // If adding this sentence exceeds the chunk size, flush the buffer
    if (bufferTokens + sentenceTokens > CHUNK_SIZE && buffer.length > 0) {
      const text = buffer.join(' ')
      chunks.push({
        documentId,
        tenantId,
        chunkIndex,
        text,
        tokenCount: estimateTokens(text),
      })
      chunkIndex++

      // Keep the overlap window — drop sentences from the front until
      // the remaining buffer is within the overlap budget
      while (buffer.length > 0 && bufferTokens > CHUNK_OVERLAP) {
        const removed = buffer.shift()
        bufferTokens -= estimateTokens(removed ?? '')
      }
    }

    buffer.push(sentence)
    bufferTokens += sentenceTokens
  }

  // Flush remaining sentences
  if (buffer.length > 0) {
    const text = buffer.join(' ')
    chunks.push({
      documentId,
      tenantId,
      chunkIndex,
      text,
      tokenCount: estimateTokens(text),
    })
  }

  return chunks
}
