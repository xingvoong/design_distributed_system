import Fastify from 'fastify'
import { createAuthHandler, parseApiKeys } from './auth.js'
import { createRateLimiter } from './rate-limiter.js'
import { registerRoutes } from './routes.js'

const PORT = Number(process.env['PORT'] ?? 3000)
const INGEST_URL = process.env['INGEST_URL'] ?? 'http://localhost:3004'
const QUERY_URL = process.env['QUERY_URL'] ?? 'http://localhost:3005'
const API_KEYS_RAW = process.env['API_KEYS'] ?? ''

/**
 * Rate limit: 100 requests per tenant per minute.
 * Configurable via env for different environments.
 */
const RATE_LIMIT_MAX = Number(process.env['RATE_LIMIT_MAX'] ?? 100)
const RATE_LIMIT_WINDOW_MS = Number(process.env['RATE_LIMIT_WINDOW_MS'] ?? 60_000)

const validKeys = parseApiKeys(API_KEYS_RAW)

if (validKeys.size === 0) {
  console.warn('API_KEYS is empty — all requests will be rejected')
}

async function main() {
  // addContentTypeParser is needed to access req.rawBody for proxying
  const app = Fastify({
    logger: true,
    bodyLimit: 10 * 1024 * 1024, // 10MB — covers large document uploads
  })

  // Capture the raw body so the proxy can forward it verbatim
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body)
  })

  // Override JSON parsing to also store raw body
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
    try {
      const parsed = JSON.parse((body as Buffer).toString())
      done(null, parsed)
    } catch (err) {
      done(err as Error)
    }
  })

  // Store raw body on every request so the proxy can forward it
  app.addHook('preHandler', async (req) => {
    if (Buffer.isBuffer(req.body)) {
      req.rawBody = req.body
    } else if (req.body !== null && req.body !== undefined) {
      req.rawBody = Buffer.from(JSON.stringify(req.body))
    }
  })

  const authHandler = createAuthHandler({ validKeys })
  const rateLimitHandler = createRateLimiter({
    maxRequests: RATE_LIMIT_MAX,
    windowMs: RATE_LIMIT_WINDOW_MS,
  })

  registerRoutes(app, {
    ingestUrl: INGEST_URL,
    queryUrl: QUERY_URL,
    authHandler,
    rateLimitHandler,
  })

  await app.listen({ port: PORT, host: '0.0.0.0' })
  console.log({ port: PORT }, 'api-gateway listening')

  async function shutdown(signal: string) {
    console.log({ signal }, 'shutting down')
    await app.close()
    process.exit(0)
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

main().catch((err) => {
  console.error(err, 'api-gateway crashed')
  process.exit(1)
})
