import type { EmbeddingProvider } from './types.js'

// Dimensions must match the real provider so pgvector schema stays consistent.
// text-embedding-3-small outputs 1536 dimensions.
const DIMENSIONS = 1536

export function createStubProvider(): EmbeddingProvider {
  return {
    name: 'stub',

    async embed(texts: string[]): Promise<number[][]> {
      return texts.map(() => new Array(DIMENSIONS).fill(0) as number[])
    },
  }
}
