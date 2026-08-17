import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { createRateLimiter } from '../rate-limiter.js'

function buildApp(maxRequests: number, windowMs: number) {
  const app = Fastify({ logger: false })
  const rateLimitHandler = createRateLimiter({ maxRequests, windowMs })

  app.post('/action', { preHandler: [rateLimitHandler] }, async () => ({ ok: true }))
  return app
}

function request(app: FastifyInstance, tenantId: string) {
  return app.inject({
    method: 'POST',
    url: '/action',
    payload: { tenantId },
  })
}

describe('rate limiter', () => {
  let app: FastifyInstance

  beforeEach(() => {
    app = buildApp(3, 60_000)
  })

  afterEach(async () => {
    await app.close()
  })

  it('allows requests up to the limit', async () => {
    for (let i = 0; i < 3; i++) {
      const res = await request(app, 'tenant-a')
      expect(res.statusCode).toBe(200)
    }
  })

  it('returns 429 after the limit is exceeded', async () => {
    for (let i = 0; i < 3; i++) await request(app, 'tenant-a')

    const res = await request(app, 'tenant-a')
    expect(res.statusCode).toBe(429)
    expect(res.json()).toMatchObject({ error: 'rate limit exceeded' })
  })

  it('includes retryAfterMs in the 429 response', async () => {
    for (let i = 0; i < 3; i++) await request(app, 'tenant-a')

    const res = await request(app, 'tenant-a')
    expect(res.json<{ retryAfterMs: number }>().retryAfterMs).toBe(60_000)
  })

  it('tracks tenants independently', async () => {
    // Exhaust tenant-a
    for (let i = 0; i < 3; i++) await request(app, 'tenant-a')
    const blockedRes = await request(app, 'tenant-a')
    expect(blockedRes.statusCode).toBe(429)

    // tenant-b should still be allowed
    const allowedRes = await request(app, 'tenant-b')
    expect(allowedRes.statusCode).toBe(200)
  })

  it('resets the count after the window expires', async () => {
    // Window of 50ms so we don't have to wait long
    const shortWindowApp = buildApp(2, 50)

    try {
      for (let i = 0; i < 2; i++) await request(shortWindowApp, 'tenant-a')
      const blocked = await request(shortWindowApp, 'tenant-a')
      expect(blocked.statusCode).toBe(429)

      // Wait for window to expire
      await new Promise((r) => setTimeout(r, 60))

      const allowed = await request(shortWindowApp, 'tenant-a')
      expect(allowed.statusCode).toBe(200)
    } finally {
      await shortWindowApp.close()
    }
  })

  it('passes through when no tenantId is present', async () => {
    // No tenantId — rate limiter skips, downstream handles it
    const res = await app.inject({ method: 'POST', url: '/action', payload: {} })
    expect(res.statusCode).toBe(200)
  })
})
