import 'fastify'

declare module 'fastify' {
  interface FastifyRequest {
    /** Raw request body buffer, set by the preHandler hook for proxy forwarding. */
    rawBody?: Buffer
  }
}
