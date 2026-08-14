import { createAIAdapter, createHttpProvider, createStubProvider } from '@docflow/ai-adapter'
import Fastify from 'fastify'
import { registerRoutes } from './routes.js'

const PORT = Number(process.env['PORT'] ?? 3003)

const primaryConfig = {
  baseUrl: process.env['EMBEDDING_API_URL'] ?? 'https://api.openai.com',
  apiKey: process.env['EMBEDDING_API_KEY'] ?? '',
  model: process.env['EMBEDDING_MODEL'] ?? 'text-embedding-3-small',
}

async function main() {
  const adapter = createAIAdapter({
    primary: createHttpProvider(primaryConfig),
    fallback: createStubProvider(),
    circuitBreaker: {
      failureThreshold: 5,
      cooldownMs: 30_000,
    },
  })

  const app = Fastify({ logger: true })
  registerRoutes(app, adapter)

  await app.listen({ port: PORT, host: '0.0.0.0' })
  console.log({ port: PORT }, 'ai-inference listening')

  async function shutdown(signal: string) {
    console.log({ signal }, 'shutting down')
    await adapter.close()
    await app.close()
    process.exit(0)
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

main().catch((err) => {
  console.error(err, 'ai-inference crashed')
  process.exit(1)
})
