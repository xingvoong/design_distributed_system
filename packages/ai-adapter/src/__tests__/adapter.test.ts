import { describe, it, expect } from 'vitest'
import { createAIAdapter } from '../adapter.js'
import type { EmbeddingProvider } from '../types.js'

function makeProvider(name: string, fail = false): EmbeddingProvider {
  return {
    name,
    async embed(texts) {
      if (fail) throw new Error(`${name} failed`)
      return texts.map(() => [1, 2, 3])
    },
  }
}

describe('createAIAdapter', () => {
  it('uses primary when it succeeds', async () => {
    const adapter = createAIAdapter({
      primary: makeProvider('openai'),
      fallback: makeProvider('stub'),
    })
    const result = await adapter.embed(['hello'])
    expect(result.provider).toBe('openai')
  })

  it('returns one embedding per text', async () => {
    const adapter = createAIAdapter({
      primary: makeProvider('openai'),
      fallback: makeProvider('stub'),
    })
    const result = await adapter.embed(['a', 'b', 'c'])
    expect(result.embeddings).toHaveLength(3)
  })

  it('records durationMs', async () => {
    const adapter = createAIAdapter({
      primary: makeProvider('openai'),
      fallback: makeProvider('stub'),
    })
    const result = await adapter.embed(['test'])
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('falls back to fallback when primary throws', async () => {
    const adapter = createAIAdapter({
      primary: makeProvider('openai', true),
      fallback: makeProvider('stub'),
    })
    const result = await adapter.embed(['hello'])
    expect(result.provider).toBe('stub')
  })

  it('skips primary and uses fallback when primary circuit is OPEN', async () => {
    const adapter = createAIAdapter({
      primary: makeProvider('openai', true),
      fallback: makeProvider('stub'),
      circuitBreaker: { failureThreshold: 1, cooldownMs: 60_000 },
    })

    // First call opens the circuit
    const first = await adapter.embed(['a'])
    expect(first.provider).toBe('stub')

    // Circuit is now OPEN — primary should be skipped entirely
    expect(adapter.circuitState()).toBe('OPEN')
    const second = await adapter.embed(['b'])
    expect(second.provider).toBe('stub')
  })

  it('circuitState reflects primary circuit', async () => {
    const adapter = createAIAdapter({
      primary: makeProvider('openai'),
      fallback: makeProvider('stub'),
    })
    expect(adapter.circuitState()).toBe('CLOSED')
  })

  it('close resolves without error', async () => {
    const adapter = createAIAdapter({
      primary: makeProvider('openai'),
      fallback: makeProvider('stub'),
    })
    await expect(adapter.close()).resolves.toBeUndefined()
  })
})
