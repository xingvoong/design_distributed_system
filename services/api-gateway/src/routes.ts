import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { createAuthHandler } from './auth.js'
import { createRateLimiter } from './rate-limiter.js'

export interface GatewayConfig {
  ingestUrl: string
  queryUrl: string
  authHandler: ReturnType<typeof createAuthHandler>
  rateLimitHandler: ReturnType<typeof createRateLimiter>
}

/**
 * Forwards a request to an upstream service, preserving method, headers, and body.
 * Streams the upstream response back to the client unchanged.
 */
async function proxy(
  req: FastifyRequest,
  reply: FastifyReply,
  targetUrl: string,
): Promise<void> {
  const headers: Record<string, string> = { 'content-type': req.headers['content-type'] ?? '' }
  if (req.headers['x-api-key']) headers['x-api-key'] = req.headers['x-api-key'] as string

  const upstream = await fetch(targetUrl, {
    method: req.method,
    headers,
    ...(req.rawBody !== undefined ? { body: req.rawBody } : {}),
  })

  const body = await upstream.arrayBuffer()

  void reply
    .code(upstream.status)
    .header('content-type', upstream.headers.get('content-type') ?? 'application/json')
    .send(Buffer.from(body))
}

export function registerRoutes(app: FastifyInstance, config: GatewayConfig) {
  const preHandler = [config.authHandler, config.rateLimitHandler]

  /**
   * POST /ingest
   * Proxies to ingest-service. Accepts multipart/form-data.
   * Rate limited per tenantId (read from the X-Tenant-Id header for multipart).
   */
  app.post('/ingest', { preHandler }, async (req, reply) => {
    await proxy(req, reply, `${config.ingestUrl}/ingest`)
  })

  /**
   * POST /query
   * Proxies to query-service. Expects JSON body with { query, tenantId, topK? }.
   */
  app.post('/query', { preHandler }, async (req, reply) => {
    await proxy(req, reply, `${config.queryUrl}/query`)
  })

  app.get('/healthz', async () => ({ status: 'ok' }))

  app.get('/readyz', async (_req, reply) => {
    // Check both upstreams are reachable
    const [ingestOk, queryOk] = await Promise.all([
      fetch(`${config.ingestUrl}/healthz`).then((r) => r.ok).catch(() => false),
      fetch(`${config.queryUrl}/healthz`).then((r) => r.ok).catch(() => false),
    ])

    if (!ingestOk || !queryOk) {
      return reply.code(503).send({
        status: 'not ready',
        ingest: ingestOk,
        query: queryOk,
      })
    }

    return { status: 'ok', ingest: true, query: true }
  })
}
