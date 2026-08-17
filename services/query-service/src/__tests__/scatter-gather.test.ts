import { describe, it, expect, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import { scatterGather } from '../scatter-gather.js'
import type { ChunkSearchResult } from '@docflow/db'

/**
 * Creates a fake PrismaClient whose $queryRaw returns the given results.
 * scatterGather calls searchEmbeddedChunks, which calls prisma.$queryRaw.
 * We mock at that level to avoid needing a real database.
 */
function makeShard(results: ChunkSearchResult[]): PrismaClient {
  return {
    $queryRaw: vi.fn().mockResolvedValue(results),
  } as unknown as PrismaClient
}

function makeFailingShard(): PrismaClient {
  return {
    $queryRaw: vi.fn().mockRejectedValue(new Error('shard unavailable')),
  } as unknown as PrismaClient
}

function makeResult(overrides: Partial<ChunkSearchResult> = {}): ChunkSearchResult {
  return {
    id: 'chunk-1',
    documentId: 'doc-1',
    tenantId: 'tenant-a',
    chunkIndex: 0,
    text: 'some text',
    score: 0.5,
    ...overrides,
  }
}

const QUERY_VEC = new Array(1536).fill(0) as number[]

describe('scatterGather', () => {
  describe('fan-out', () => {
    it('queries all shards', async () => {
      const shard0 = makeShard([makeResult({ id: 'a', score: 0.2 })])
      const shard1 = makeShard([makeResult({ id: 'b', score: 0.4 })])
      const shard2 = makeShard([makeResult({ id: 'c', score: 0.6 })])

      await scatterGather([shard0, shard1, shard2], 'tenant-a', QUERY_VEC, 10)

      expect(shard0.$queryRaw).toHaveBeenCalledOnce()
      expect(shard1.$queryRaw).toHaveBeenCalledOnce()
      expect(shard2.$queryRaw).toHaveBeenCalledOnce()
    })

    it('attaches shardIndex to each result', async () => {
      const shard0 = makeShard([makeResult({ id: 'a' })])
      const shard1 = makeShard([makeResult({ id: 'b' })])

      const results = await scatterGather([shard0, shard1], 'tenant-a', QUERY_VEC, 10)

      const shardIndexes = results.map((r) => r.shardIndex).sort()
      expect(shardIndexes).toEqual([0, 1])
    })
  })

  describe('merge and re-rank', () => {
    it('returns results sorted by score ascending (lowest = closest)', async () => {
      const shard0 = makeShard([
        makeResult({ id: 'a', score: 0.8 }),
        makeResult({ id: 'b', score: 0.3 }),
      ])
      const shard1 = makeShard([
        makeResult({ id: 'c', score: 0.1 }),
        makeResult({ id: 'd', score: 0.5 }),
      ])

      const results = await scatterGather([shard0, shard1], 'tenant-a', QUERY_VEC, 10)

      expect(results.map((r) => r.id)).toEqual(['c', 'b', 'd', 'a'])
    })

    it('global re-rank: a result ranked 2nd on its shard can beat a 1st on another', async () => {
      // shard0's best is 0.4, shard1's best is 0.2 and second is 0.3
      const shard0 = makeShard([makeResult({ id: 'a', score: 0.4 })])
      const shard1 = makeShard([
        makeResult({ id: 'b', score: 0.2 }),
        makeResult({ id: 'c', score: 0.3 }),
      ])

      const results = await scatterGather([shard0, shard1], 'tenant-a', QUERY_VEC, 10)

      expect(results[0]!.id).toBe('b')
      expect(results[1]!.id).toBe('c')
      expect(results[2]!.id).toBe('a')
    })

    it('truncates to topK after merging', async () => {
      const shard0 = makeShard([
        makeResult({ id: 'a', score: 0.1 }),
        makeResult({ id: 'b', score: 0.2 }),
        makeResult({ id: 'c', score: 0.3 }),
      ])
      const shard1 = makeShard([
        makeResult({ id: 'd', score: 0.15 }),
        makeResult({ id: 'e', score: 0.25 }),
      ])

      const results = await scatterGather([shard0, shard1], 'tenant-a', QUERY_VEC, 3)

      expect(results).toHaveLength(3)
      expect(results.map((r) => r.id)).toEqual(['a', 'd', 'b'])
    })
  })

  describe('shard failures', () => {
    it('skips a failing shard and returns results from the rest', async () => {
      const shard0 = makeShard([makeResult({ id: 'a', score: 0.2 })])
      const shard1 = makeFailingShard()
      const shard2 = makeShard([makeResult({ id: 'c', score: 0.4 })])

      const results = await scatterGather([shard0, shard1, shard2], 'tenant-a', QUERY_VEC, 10)

      expect(results).toHaveLength(2)
      expect(results.map((r) => r.id)).toEqual(['a', 'c'])
    })

    it('returns empty array when all shards fail', async () => {
      const results = await scatterGather(
        [makeFailingShard(), makeFailingShard()],
        'tenant-a',
        QUERY_VEC,
        10,
      )

      expect(results).toEqual([])
    })

    it('does not throw when a shard fails', async () => {
      await expect(
        scatterGather([makeFailingShard()], 'tenant-a', QUERY_VEC, 10),
      ).resolves.not.toThrow()
    })
  })

  describe('edge cases', () => {
    it('returns empty array with no shards', async () => {
      const results = await scatterGather([], 'tenant-a', QUERY_VEC, 10)
      expect(results).toEqual([])
    })

    it('returns empty array when shards have no matching rows', async () => {
      const results = await scatterGather(
        [makeShard([]), makeShard([])],
        'tenant-a',
        QUERY_VEC,
        10,
      )
      expect(results).toEqual([])
    })

    it('topK of 1 returns only the best result across all shards', async () => {
      const shard0 = makeShard([makeResult({ id: 'a', score: 0.5 })])
      const shard1 = makeShard([makeResult({ id: 'b', score: 0.1 })])

      const results = await scatterGather([shard0, shard1], 'tenant-a', QUERY_VEC, 1)

      expect(results).toHaveLength(1)
      expect(results[0]!.id).toBe('b')
    })
  })
})
