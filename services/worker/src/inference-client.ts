import type { DocumentChunk } from '@docflow/types'

export interface InferenceClient {
  embed(chunks: DocumentChunk[], tenantId: string, jobId: string): Promise<number[][]>
}

export function createInferenceClient(baseUrl: string): InferenceClient {
  return {
    async embed(chunks, tenantId, jobId) {
      const response = await fetch(`${baseUrl}/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chunks, tenantId, jobId }),
      })

      if (!response.ok) {
        const body = await response.text()
        throw new Error(`Inference service ${response.status}: ${body}`)
      }

      const data = (await response.json()) as { embeddings: number[][] }
      return data.embeddings
    },
  }
}
