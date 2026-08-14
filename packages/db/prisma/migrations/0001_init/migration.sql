CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE "EmbeddedChunk" (
  "id"             TEXT NOT NULL PRIMARY KEY,
  "documentId"     TEXT NOT NULL,
  "tenantId"       TEXT NOT NULL,
  "chunkIndex"     INTEGER NOT NULL,
  "text"           TEXT NOT NULL,
  "tokenCount"     INTEGER NOT NULL,
  "embedding"      vector(1536) NOT NULL,
  "embeddingModel" TEXT NOT NULL,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "EmbeddedChunk_documentId_idx" ON "EmbeddedChunk"("documentId");
CREATE INDEX "EmbeddedChunk_tenantId_idx" ON "EmbeddedChunk"("tenantId");
