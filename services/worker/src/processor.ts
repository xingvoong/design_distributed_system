import { readFile } from 'node:fs/promises'
import type { DocumentChunk, DocumentJob } from '@docflow/types'
import { chunkText } from './chunker.js'

export interface ProcessResult {
  documentId: string
  tenantId: string
  chunks: DocumentChunk[]
  processingMs: number
}

export async function processDocument(job: DocumentJob): Promise<ProcessResult> {
  const start = Date.now()

  const raw = await readFile(job.source, 'utf-8')
  const text = extractText(raw, job.mimeType)
  const chunks = chunkText(text, job.documentId, job.tenantId)

  return {
    documentId: job.documentId,
    tenantId: job.tenantId,
    chunks,
    processingMs: Date.now() - start,
  }
}

function extractText(
  raw: string,
  mimeType: DocumentJob['mimeType'],
): string {
  switch (mimeType) {
    case 'text/plain':
    case 'text/markdown':
      return raw

    case 'application/pdf':
      // PDF binary parsing comes in phase 3 with the AI inference layer.
      // For now treat the raw content as text so the pipeline stays runnable.
      return raw

    default: {
      const _exhaustive: never = mimeType
      return _exhaustive
    }
  }
}
