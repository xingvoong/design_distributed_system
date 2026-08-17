import { describe, it, expect } from 'vitest'
import Fastify from 'fastify'
import { createAuthHandler, parseApiKeys } from '../auth.js'

function buildApp(keys: string[]) {
  const app = Fastify({ logger: false })
  const authHandler = createAuthHandler({ validKeys: new Set(keys) })
  app.get('/protected', { preHandler: [authHandler] }, async () => ({ ok: true }))
  return app
}

describe('parseApiKeys', () => {
  it('parses a comma-separated list', () => {
    const keys = parseApiKeys('key1,key2,key3')
    expect(keys).toEqual(new Set(['key1', 'key2', 'key3']))
  })

  it('trims whitespace', () => {
    const keys = parseApiKeys('key1, key2 , key3')
    expect(keys).toEqual(new Set(['key1', 'key2', 'key3']))
  })

  it('filters empty strings from trailing commas', () => {
    const keys = parseApiKeys('key1,key2,')
    expect(keys).toEqual(new Set(['key1', 'key2']))
  })

  it('returns empty set for empty string', () => {
    expect(parseApiKeys('')).toEqual(new Set())
  })
})

describe('auth middleware', () => {
  it('returns 401 when X-API-Key header is missing', async () => {
    const app = buildApp(['valid-key'])
    const res = await app.inject({ method: 'GET', url: '/protected' })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toMatchObject({ error: 'invalid or missing API key' })
  })

  it('returns 401 when X-API-Key is wrong', async () => {
    const app = buildApp(['valid-key'])
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { 'x-api-key': 'wrong-key' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('passes through when X-API-Key is valid', async () => {
    const app = buildApp(['valid-key'])
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { 'x-api-key': 'valid-key' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ ok: true })
  })

  it('accepts any key in the valid set', async () => {
    const app = buildApp(['key-a', 'key-b', 'key-c'])
    for (const key of ['key-a', 'key-b', 'key-c']) {
      const res = await app.inject({
        method: 'GET',
        url: '/protected',
        headers: { 'x-api-key': key },
      })
      expect(res.statusCode).toBe(200)
    }
  })

  it('returns 401 when key set is empty', async () => {
    const app = buildApp([])
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { 'x-api-key': 'any-key' },
    })
    expect(res.statusCode).toBe(401)
  })
})
