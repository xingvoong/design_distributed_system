import { createCircuitBreaker } from './circuit-breaker.js'
import type { AIAdapter, AIAdapterConfig, EmbedResult } from './types.js'

export function createAIAdapter(config: AIAdapterConfig): AIAdapter {
  const primary = createCircuitBreaker(config.primary, config.circuitBreaker ?? {})
  const fallback = createCircuitBreaker(config.fallback, config.circuitBreaker ?? {})

  return {
    circuitState: () => primary.getState(),

    async embed(texts: string[]): Promise<EmbedResult> {
      const start = Date.now()

      // Try primary first
      if (primary.getState() !== 'OPEN') {
        try {
          const embeddings = await primary.embed(texts)
          return { embeddings, provider: primary.name, durationMs: Date.now() - start }
        } catch {
          console.error({ provider: primary.name }, 'primary provider failed — trying fallback')
        }
      }

      // Primary is open or just failed — use fallback
      const embeddings = await fallback.embed(texts)
      return { embeddings, provider: fallback.name, durationMs: Date.now() - start }
    },

    async close(): Promise<void> {
      // Providers are stateless HTTP clients — nothing to drain
    },
  }
}
