import Fastify from 'fastify'

export function createHealthServer(port: number) {
  const app = Fastify({ logger: false })

  // Kubernetes liveness probe — is the process alive?
  app.get('/healthz', async () => ({ status: 'ok' }))

  // Kubernetes readiness probe — is the worker ready to process jobs?
  let ready = false
  app.get('/readyz', async (_req, reply) => {
    if (!ready) {
      return reply.code(503).send({ status: 'not ready' })
    }
    return { status: 'ok' }
  })

  return {
    async start() {
      await app.listen({ port, host: '0.0.0.0' })
      console.log({ port }, 'health server listening')
    },
    setReady(value: boolean) {
      ready = value
    },
    async stop() {
      await app.close()
    },
  }
}
