// Document job — produced by the coordinator, consumed by workers
export interface DocumentJob {
  documentId: string
  tenantId: string
  source: string   // original file path or URL
  mimeType: 'text/plain' | 'application/pdf' | 'text/markdown'
  sizeBytes: number
}

// A single chunk produced by the worker after splitting the document
export interface DocumentChunk {
  documentId: string
  tenantId: string
  chunkIndex: number
  text: string
  tokenCount: number
}

// A chunk with its embedding vector — produced by ai-inference, stored in pgvector
export interface EmbeddedChunk extends DocumentChunk {
  embedding: number[]
  embeddingModel: string
}

// Status a document moves through
export type DocumentStatus =
  | 'pending'
  | 'processing'
  | 'chunked'
  | 'embedded'
  | 'failed'
