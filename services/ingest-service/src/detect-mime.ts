import { extname } from 'node:path'
import type { DocumentJob } from '@docflow/types'

type MimeType = DocumentJob['mimeType']

const EXT_MAP: Record<string, MimeType> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.pdf': 'application/pdf',
}

export function detectMimeType(filename: string): MimeType {
  const ext = extname(filename).toLowerCase()
  const mime = EXT_MAP[ext]
  if (!mime) throw new Error(`Unsupported file type: ${ext || '(no extension)'}`)
  return mime
}
