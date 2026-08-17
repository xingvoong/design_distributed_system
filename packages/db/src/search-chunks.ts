import type { PrismaClient } from '@prisma/client'

export interface ChunkSearchResult {
  id: string
  documentId: string
  tenantId: string
  chunkIndex: number
  text: string
  /** Cosine distance — lower is closer. 0 = identical, 2 = opposite. */
  score: number
}

/**
 * Finds the top-K chunks closest to `queryEmbedding` for a given tenant.
 * Uses pgvector's cosine distance operator (<=>) so results are ordered
 * nearest-first (lowest score first).
 *
 * Uses $queryRaw because Prisma cannot generate parameterized SQL for
 * the vector(1536) column.
 */
export async function searchEmbeddedChunks(
  prisma: PrismaClient,
  tenantId: string,
  queryEmbedding: number[],
  topK: number,
): Promise<ChunkSearchResult[]> {
  const vectorLiteral = `[${queryEmbedding.join(',')}]`

  const rows = await prisma.$queryRaw<ChunkSearchResult[]>`
    SELECT
      id,
      "documentId",
      "tenantId",
      "chunkIndex",
      text,
      (embedding <=> ${vectorLiteral}::vector)::float8 AS score
    FROM "EmbeddedChunk"
    WHERE "tenantId" = ${tenantId}
    ORDER BY score ASC
    LIMIT ${topK}
  `

  return rows
}
