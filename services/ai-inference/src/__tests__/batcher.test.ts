import { describe, it, expect } from 'vitest'
import { batchChunks } from '../batcher.js'
import type { DocumentChunk } from '@docflow/types'

function makeChunks(count: number): DocumentChunk[] {
  return Array.from({ length: count }, (_, i) => ({
    documentId: 'doc-1',
    tenantId: 'tenant-a',
    chunkIndex: i,
    text: `chunk ${i}`,
    tokenCount: 10,
  }))
}

describe('batchChunks', () => {
  it('returns a single batch when chunks <= 96', () => {
    const batches = batchChunks(makeChunks(50))
    expect(batches).toHaveLength(1)
    expect(batches[0]).toHaveLength(50)
  })

  it('returns a single batch for exactly 96 chunks', () => {
    const batches = batchChunks(makeChunks(96))
    expect(batches).toHaveLength(1)
    expect(batches[0]).toHaveLength(96)
  })

  it('splits into two batches for 97 chunks', () => {
    const batches = batchChunks(makeChunks(97))
    expect(batches).toHaveLength(2)
    expect(batches[0]).toHaveLength(96)
    expect(batches[1]).toHaveLength(1)
  })

  it('preserves all chunks across batches', () => {
    const chunks = makeChunks(200)
    const batches = batchChunks(chunks)
    const flattened = batches.flat()
    expect(flattened).toHaveLength(200)
    expect(flattened[0]!.chunkIndex).toBe(0)
    expect(flattened[199]!.chunkIndex).toBe(199)
  })

  it('returns empty array for empty input', () => {
    const batches = batchChunks([])
    expect(batches).toHaveLength(0)
  })
})
