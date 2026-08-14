import { randomUUID } from 'node:crypto'
import type { PrismaClient } from '@prisma/client'

export interface ChunkToWrite {
  documentId: string
  tenantId: string
  chunkIndex: number
  text: string
  tokenCount: number
  embedding: number[]
  embeddingModel: string
}

/**
 * Inserts embedded chunks into pgvector.
 * Uses $executeRaw because Prisma cannot generate parameterized SQL
 * for the vector(1536) column type — it marks it Unsupported.
 */
export async function writeEmbeddedChunks(
  prisma: PrismaClient,
  chunks: ChunkToWrite[],
): Promise<void> {
  for (const chunk of chunks) {
    const id = randomUUID()
    // Postgres accepts '[1.0,2.0,...]'::vector — safe to interpolate the
    // array literal since all values come from the embedding model (floats).
    const vectorLiteral = `[${chunk.embedding.join(',')}]`

    await prisma.$executeRaw`
      INSERT INTO "EmbeddedChunk"
        (id, "documentId", "tenantId", "chunkIndex", text, "tokenCount", embedding, "embeddingModel", "createdAt")
      VALUES
        (${id}, ${chunk.documentId}, ${chunk.tenantId}, ${chunk.chunkIndex},
         ${chunk.text}, ${chunk.tokenCount}, ${vectorLiteral}::vector,
         ${chunk.embeddingModel}, NOW())
    `
  }
}
