import type { CircuitBreakerConfig, CircuitState, WrappedProvider } from './types.js'
import type { EmbeddingProvider } from './types.js'

const DEFAULT_FAILURE_THRESHOLD = 5
const DEFAULT_COOLDOWN_MS = 30_000

export function createCircuitBreaker(
  provider: EmbeddingProvider,
  config: CircuitBreakerConfig = {},
): WrappedProvider {
  const failureThreshold = config.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD
  const cooldownMs = config.cooldownMs ?? DEFAULT_COOLDOWN_MS

  let state: CircuitState = 'CLOSED'
  let failures = 0
  let openedAt: number | null = null
  // Prevents multiple simultaneous probe requests in HALF_OPEN
  let probing = false

  function open() {
    state = 'OPEN'
    openedAt = Date.now()
    console.error({ provider: provider.name, failures }, 'circuit opened')
  }

  function close() {
    state = 'CLOSED'
    failures = 0
    openedAt = null
    console.log({ provider: provider.name }, 'circuit closed')
  }

  return {
    name: provider.name,
    getState: () => state,

    async embed(texts: string[]): Promise<number[][]> {
      // OPEN: check if cooldown has elapsed before rejecting
      if (state === 'OPEN') {
        const elapsed = Date.now() - (openedAt ?? 0)
        if (elapsed < cooldownMs) {
          throw new Error(`Circuit open for provider "${provider.name}"`)
        }
        state = 'HALF_OPEN'
        console.log({ provider: provider.name }, 'circuit half-open — probing')
      }

      // HALF_OPEN: only one probe at a time
      if (state === 'HALF_OPEN') {
        if (probing) {
          throw new Error(`Circuit half-open, probe in progress for "${provider.name}"`)
        }
        probing = true
        try {
          const result = await provider.embed(texts)
          close()
          return result
        } catch (err) {
          open()
          throw err
        } finally {
          probing = false
        }
      }

      // CLOSED: normal path
      try {
        const result = await provider.embed(texts)
        // Reset failure count on any success — we only open on consecutive failures
        failures = 0
        return result
      } catch (err) {
        failures++
        if (failures >= failureThreshold) {
          open()
        }
        throw err
      }
    },
  }
}
