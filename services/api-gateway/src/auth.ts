import type { FastifyReply, FastifyRequest } from 'fastify'

export interface AuthConfig {
  /** Validated API keys. Any request not carrying one is rejected with 401. */
  validKeys: Set<string>
}

/**
 * Fastify preHandler that enforces API key authentication.
 * Reads the key from the X-API-Key header.
 * Returns 401 when the header is missing or the key is not in validKeys.
 */
export function createAuthHandler(config: AuthConfig) {
  return async function authHandler(req: FastifyRequest, reply: FastifyReply) {
    const key = req.headers['x-api-key']

    if (typeof key !== 'string' || !config.validKeys.has(key)) {
      return reply.code(401).send({ error: 'invalid or missing API key' })
    }
  }
}

/**
 * Parses a comma-separated list of API keys from an env var string.
 * Filters out empty strings so a trailing comma doesn't create a blank key.
 */
export function parseApiKeys(raw: string): Set<string> {
  return new Set(raw.split(',').map((k) => k.trim()).filter(Boolean))
}
