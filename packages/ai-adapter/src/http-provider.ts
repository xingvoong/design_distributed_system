import type { EmbeddingProvider } from './types.js'

export interface HttpProviderConfig {
  /** Base URL of the embedding API. e.g. https://api.openai.com */
  baseUrl: string
  apiKey: string
  model: string
  /** Request timeout in milliseconds. Default: 10_000 */
  timeoutMs?: number
}

interface EmbeddingResponse {
  data: Array<{ embedding: number[]; index: number }>
}

export function createHttpProvider(config: HttpProviderConfig): EmbeddingProvider {
  const timeoutMs = config.timeoutMs ?? 10_000

  return {
    name: config.model,

    async embed(texts: string[]): Promise<number[][]> {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)

      let response: Response
      try {
        response = await fetch(`${config.baseUrl}/v1/embeddings`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify({ input: texts, model: config.model }),
          signal: controller.signal,
        })
      } finally {
        clearTimeout(timer)
      }

      if (!response.ok) {
        const body = await response.text()
        throw new Error(`Embedding API ${response.status}: ${body}`)
      }

      const json = (await response.json()) as EmbeddingResponse

      // API returns embeddings in arbitrary order — sort by index to match input order
      return json.data
        .sort((a, b) => a.index - b.index)
        .map((item) => item.embedding)
    },
  }
}
