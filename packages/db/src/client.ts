import { PrismaClient } from '@prisma/client'

/**
 * Creates a PrismaClient connected to the given URL.
 * Falls back to DATABASE_URL env var when no URL is provided —
 * keeps existing callers working without changes.
 */
export function createPrismaClient(url?: string): PrismaClient {
  if (url) {
    return new PrismaClient({ datasources: { db: { url } } })
  }
  return new PrismaClient()
}
