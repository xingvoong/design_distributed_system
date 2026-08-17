import type { FastifyReply, FastifyRequest } from 'fastify'

export interface RateLimiterConfig {
  /** Max requests allowed per tenant per window. */
  maxRequests: number
  /** Window duration in milliseconds. */
  windowMs: number
}

interface Bucket {
  count: number
  windowStart: number
}

/**
 * In-memory token bucket rate limiter, keyed by tenantId.
 *
 * Each tenant gets maxRequests per windowMs. When the window expires
 * the count resets. Requests over the limit get 429.
 *
 * tenantId is read from the parsed request body. If the body hasn't been
 * parsed yet (e.g. multipart), falls back to the X-Tenant-Id header.
 */
export function createRateLimiter(config: RateLimiterConfig) {
  const buckets = new Map<string, Bucket>()

  function isAllowed(tenantId: string): boolean {
    const now = Date.now()
    const bucket = buckets.get(tenantId)

    if (!bucket || now - bucket.windowStart >= config.windowMs) {
      buckets.set(tenantId, { count: 1, windowStart: now })
      return true
    }

    if (bucket.count >= config.maxRequests) {
      return false
    }

    bucket.count++
    return true
  }

  return async function rateLimitHandler(req: FastifyRequest, reply: FastifyReply) {
    const body = req.body as Record<string, unknown> | undefined
    const tenantId =
      (typeof body?.['tenantId'] === 'string' ? body['tenantId'] : undefined) ??
      (req.headers['x-tenant-id'] as string | undefined)

    if (!tenantId) {
      // No tenantId — let the downstream service reject it with a proper error
      return
    }

    if (!isAllowed(tenantId)) {
      return reply.code(429).send({
        error: 'rate limit exceeded',
        retryAfterMs: config.windowMs,
      })
    }
  }
}
