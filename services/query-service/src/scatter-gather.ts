import { searchEmbeddedChunks } from '@docflow/db'
import type { ChunkSearchResult } from '@docflow/db'
import type { PrismaClient } from '@prisma/client'

export interface SearchResult extends ChunkSearchResult {
  shardIndex: number
}

/**
 * Fans the query embedding out to every shard in parallel.
 * Each shard returns its local top-K. We merge all shard results,
 * sort by cosine distance (ascending), then return the global top-K.
 *
 * A shard failure is logged and skipped — partial results are better
 * than a hard error when one replica is down.
 */
export async function scatterGather(
  shards: PrismaClient[],
  tenantId: string,
  queryEmbedding: number[],
  topK: number,
): Promise<SearchResult[]> {
  const shardResults = await Promise.allSettled(
    shards.map((shard, i) =>
      searchEmbeddedChunks(shard, tenantId, queryEmbedding, topK).then((rows) =>
        rows.map((r) => ({ ...r, shardIndex: i })),
      ),
    ),
  )

  const merged: SearchResult[] = []

  for (let i = 0; i < shardResults.length; i++) {
    const result = shardResults[i]!
    if (result.status === 'fulfilled') {
      merged.push(...result.value)
    } else {
      console.error({ shardIndex: i, error: result.reason }, 'shard search failed — skipping')
    }
  }

  // Global re-rank: sort by cosine distance, return global top-K
  merged.sort((a, b) => a.score - b.score)
  return merged.slice(0, topK)
}
