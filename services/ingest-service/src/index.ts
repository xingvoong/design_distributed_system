import { randomUUID } from 'node:crypto'
import { createLocalAmbassador } from '@docflow/storage-ambassador'
import multipart from '@fastify/multipart'
import Fastify from 'fastify'
import { detectMimeType } from './detect-mime.js'

const PORT = Number(process.env['PORT'] ?? 3004)
const COORDINATOR_URL = process.env['COORDINATOR_URL'] ?? 'http://localhost:3002'
const STORAGE_BASE = process.env['STORAGE_BASE'] ?? '/uploads'

async function main() {
  const storage = createLocalAmbassador(STORAGE_BASE)

  const app = Fastify({ logger: true })
  await app.register(multipart)

  /**
   * POST /ingest
   * Accepts multipart/form-data with:
   *   - file:     the document binary (required)
   *   - tenantId: string (required)
   *   - documentId: string (optional — generated if omitted)
   *
   * Returns 202 { documentId } once the job is queued.
   */
  app.post('/ingest', async (req, reply) => {
    const parts = req.parts()

    let tenantId = ''
    let documentId = ''
    let fileBuffer: Buffer | null = null
    let filename = ''

    for await (const part of parts) {
      if (part.type === 'field') {
        if (part.fieldname === 'tenantId') tenantId = part.value as string
        if (part.fieldname === 'documentId') documentId = part.value as string
      } else {
        filename = part.filename ?? 'upload'
        fileBuffer = await part.toBuffer()
      }
    }

    if (!tenantId) return reply.code(400).send({ error: 'tenantId is required' })
    if (!fileBuffer) return reply.code(400).send({ error: 'file is required' })
    if (!documentId) documentId = randomUUID()

    let mimeType: ReturnType<typeof detectMimeType>
    try {
      mimeType = detectMimeType(filename)
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message })
    }

    // Storage key mirrors an S3-style prefix: tenantId/documentId/filename
    const key = `${tenantId}/${documentId}/${filename}`
    await storage.put(key, fileBuffer, mimeType)

    // Register with the coordinator — it will enqueue the job on its next poll
    const res = await fetch(`${COORDINATOR_URL}/internal/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        documentId,
        tenantId,
        source: key,
        mimeType,
        sizeBytes: fileBuffer.length,
      }),
    })

    if (!res.ok) {
      const body = await res.text()
      req.log.error({ status: res.status, body }, 'coordinator registration failed')
      return reply.code(502).send({ error: 'coordinator unavailable' })
    }

    req.log.info({ documentId, tenantId, filename, bytes: fileBuffer.length }, 'document ingested')
    return reply.code(202).send({ documentId })
  })

  app.get('/healthz', async () => ({ status: 'ok' }))

  await app.listen({ port: PORT, host: '0.0.0.0' })
  console.log({ port: PORT }, 'ingest-service listening')

  async function shutdown(signal: string) {
    console.log({ signal }, 'shutting down')
    await app.close()
    process.exit(0)
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

main().catch((err) => {
  console.error(err, 'ingest-service crashed')
  process.exit(1)
})
