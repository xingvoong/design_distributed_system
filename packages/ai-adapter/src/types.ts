export interface EmbeddingProvider {
  readonly name: string
  embed(texts: string[]): Promise<number[][]>
}

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN'

export interface CircuitBreakerConfig {
  /** Consecutive failures before the circuit opens. Default: 5 */
  failureThreshold?: number
  /** Milliseconds to wait before moving from OPEN → HALF_OPEN. Default: 30_000 */
  cooldownMs?: number
}

export interface WrappedProvider extends EmbeddingProvider {
  getState(): CircuitState
}

export interface AIAdapterConfig {
  primary: EmbeddingProvider
  fallback: EmbeddingProvider
  circuitBreaker?: CircuitBreakerConfig
}

export interface EmbedResult {
  embeddings: number[][]
  provider: string
  durationMs: number
}

export interface AIAdapter {
  embed(texts: string[]): Promise<EmbedResult>
  /** State of the primary circuit. OPEN means primary is failing. */
  circuitState(): CircuitState
  close(): Promise<void>
}
