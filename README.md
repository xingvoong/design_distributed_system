# DocFlow
**Document Intelligence Infrastructure**

A horizontally scalable platform that ingests documents, processes them through an AI pipeline, and serves fast semantic search across a sharded vector store.

---

## The problem it solves

Retrieval doesn't scale by default. A single vector store degrades as the corpus grows. A single worker falls over under bursty load. One AI provider outage takes the whole system down. DocFlow handles all three.

---

## What it does

- Ingest documents from any source — S3, webhooks, direct upload
- Process them through a fault-tolerant AI pipeline — extract, chunk, embed, store
- Serve semantic search with consistent latency regardless of corpus size
- Isolate tenants — one customer's load doesn't affect another's
- Survive failures — AI provider outage, worker crash, shard going down

---

## Scale targets

| Metric | Target |
|---|---|
| Ingestion throughput | 10,000 docs/hour |
| Query latency (p99) | < 100ms |
| Vector store | 50M+ embeddings |
| Tenants | Multi-tenant with shard isolation |
| Worker failure recovery | Automatic, no data loss |

---

## Architecture

```
                        ┌─────────────────────────────┐
                        │         API Gateway          │
                        │   3 replicas, load balanced  │
                        └──────────┬──────────┬────────┘
                                   │          │
                         (ingest)  │          │  (query)
                                   │          │
               ┌───────────────────▼─┐    ┌───▼───────────────────┐
               │    Ingest Service   │    │     Query Service      │
               └──────────┬──────────┘    └───────────┬───────────┘
                          │                           │ scatter
               ┌──────────▼──────────┐               │
               │  Storage Ambassador │    ┌──────────┬┴──────────┐
               │  S3 / GCS / disk    │    ▼          ▼           ▼
               └──────────┬──────────┘ Shard 0    Shard 1    Shard 2
                          │            (pgvector) (pgvector) (pgvector)
               ┌──────────▼──────────┐    │          │           │
               │     Work Queue      │    └──────────┴───────────┘
               │  BullMQ + Redis     │               │ gather
               └──────────┬──────────┘               │
                          │  ← workers pull           ▼
         ┌────────────────┼────────────────┐   ranked results
         │                │                │
         ▼                ▼                ▼
      Worker           Worker           Worker
    + OTel sidecar   + OTel sidecar   + OTel sidecar
         │                │                │
         └────────────────┼────────────────┘
                          │
               ┌──────────▼──────────┐
               │    AI Inference     │
               │  + circuit breaker  │
               │  + provider adapter │
               └──────────┬──────────┘
                          │ write embeddings
         ┌────────────────┼────────────────┐
         ▼                ▼                ▼
      Shard 0          Shard 1          Shard 2
      (pgvector)       (pgvector)       (pgvector)

               ┌─────────────────────┐
               │  Pipeline Coord     │ ← manages queue + workers
               │  leader election    │    Redis SETNX + TTL
               └─────────────────────┘
```

---

## Tech stack

```
Language        TypeScript strict
Runtime         Node.js 22
HTTP            Fastify
Queue           BullMQ + Redis
Database        PostgreSQL + pgvector
ORM             Prisma
AI              Anthropic SDK
Observability   OpenTelemetry + Prometheus + Grafana
Containers      Docker + Docker Compose
Orchestration   Kubernetes
Testing         Vitest + Testcontainers
Load testing    k6
CI              GitHub Actions
```

---

## What production-grade means here

- **No mocks in integration tests** — Testcontainers spins real Postgres and Redis
- **Graceful shutdown** — workers drain the queue before terminating
- **Circuit breakers** on every external call — AI provider, storage, DB
- **Health + readiness endpoints** — Kubernetes probes, not just a ping route
- **Structured logging** — every log line has trace ID, tenant ID, job ID
- **Backpressure** — queue depth controls ingestion rate, workers don't OOM
- **Zero-downtime deploys** — rolling updates, connections drained properly
- **Kubernetes manifests** — actually deployable, not just Docker Compose

---

## Repo structure

```
/
├── services/
│   ├── api-gateway/
│   ├── ingest-service/
│   ├── query-service/
│   ├── worker/
│   ├── pipeline-coordinator/
│   └── ai-inference/
├── packages/
│   ├── queue/
│   ├── storage-ambassador/
│   ├── ai-adapter/
│   ├── otel-sidecar/
│   ├── circuit-breaker/
│   └── leader-election/
├── infra/
│   ├── docker-compose.yml
│   ├── k8s/
│   └── grafana/
└── tests/
    ├── integration/
    └── load/
```

---

## Build sequence

Each phase ships something runnable.

1. **Queue + leader election** — core primitives ✓
2. **Worker + pipeline coordinator** — batch layer functional end-to-end ✓
3. **AI inference + adapter** — embeddings flowing, provider switching works ✓
4. **Ingest service + storage ambassador** — full ingestion path live ✓
5. **Query service** — scatter/gather search across shards ✓
6. **API gateway** — public surface, auth, rate limiting ✓
7. **Infra** — observability stack, Kubernetes manifests
8. **Load tests** — validate the scale targets are real

---

## Phase 1 — Queue + Leader Election

### `@docflow/queue`

Producer puts jobs in. Consumer pulls jobs out. Redis holds the queue.

```
Producer → Redis → Consumer
```

**Files:**
```
packages/queue/src/
├── types.ts      ← Producer, Consumer, QueueConfig interfaces
├── producer.ts   ← createProducer<T>() — add, addBulk, close
├── consumer.ts   ← createConsumer<T>() — start, stop (graceful drain)
└── index.ts
```

**Design choices:**

- **Workers pull, Redis doesn't push.** A slow worker keeps getting more jobs if Redis pushes. With pulling, a slow worker just asks less often — it naturally controls its own load.
- **`addBulk()` over looping `add()`.** Every `add()` is a round-trip to Redis. `addBulk()` does it in one. At high volume, the difference adds up.
- **`stop()` drains before exit.** The consumer finishes the job it's on before shutting down. Never drops work mid-flight.

---

### `@docflow/leader-election`

Multiple nodes try to write the same key to Redis. Only one wins — that's the leader.

**Files:**
```
packages/leader-election/src/
├── types.ts     ← LeaderElection, LeaderElectionConfig, ElectionEvent
├── election.ts  ← createLeaderElection() — SET NX PX + Lua heartbeat/release
└── index.ts
```

**Design choices:**

- **Lua scripts for heartbeat and release.** The heartbeat checks if this node owns the lock, then extends it. Without Lua, those are two separate commands — another node could steal the lock in between. Lua makes it one atomic step.
- **Heartbeat interval must be shorter than TTL.** If the heartbeat fires every 10s but the lock expires after 5s, the lock dies before renewal. Another node wins, now two nodes think they're leader. This constraint is enforced at startup.
- **Nodes emit events: `elected`, `follower`, `revoked`.** Your code reacts to state changes instead of polling `isLeader()` in a loop.

---

### How phase 1 feeds phase 2

- **Worker** — calls `createConsumer()`, processes documents
- **Pipeline Coordinator** — calls `createLeaderElection()`, ensures only one node schedules jobs

Nothing in phase 1 changes from here forward.

---

## Phase 2 — Worker + Pipeline Coordinator

### `@docflow/worker`

Pulls jobs from the queue, extracts text, splits into chunks, sends to ai-inference for embedding.

**Files:**
```
services/worker/src/
├── chunker.ts          ← sentence-aware chunking with overlap
├── processor.ts        ← reads file, extracts text, calls chunker
├── inference-client.ts ← HTTP client for ai-inference service
├── health.ts           ← /healthz and /readyz for Kubernetes probes
└── index.ts            ← wires consumer + inference + health + graceful shutdown
```

**Design choices:**

- **Split on sentences, not characters.** Cutting at a fixed character count lands mid-sentence. You get a chunk that starts or ends in the middle of a thought. Sentence boundaries keep each chunk coherent.
- **64-token overlap between chunks.** Adjacent chunks share 64 tokens at their boundary. Without overlap, a sentence spanning two chunks gets split — a search query matching that sentence won't find a complete answer in either chunk.
- **Two health endpoints, not one.** `/healthz` means "is the process alive." `/readyz` means "is it ready for traffic." During shutdown, the worker flips readiness to false first — Kubernetes stops sending jobs — then drains what's in flight. One combined endpoint would cause Kubernetes to kill the pod mid-drain.

---

### `@docflow/pipeline-coordinator`

Wins leader election, then schedules document jobs into the queue. Stands by as a follower otherwise.

**Files:**
```
services/pipeline-coordinator/src/
├── scheduler.ts   ← polls for pending docs, enqueues in batches of 50
└── index.ts       ← leader election + scheduler + health + graceful shutdown
```

**Design choices:**

- **Only the leader runs the scheduler.** Without this, multiple coordinators enqueue the same documents at the same time. Leader election ensures exactly one node schedules at a time.
- **Followers stay running.** A follower that already has a Redis connection wins the next election immediately when the leader crashes. A follower that shut itself down has to reconnect first. Staying alive costs almost nothing and makes failover faster.
- **Batches of 50 via `addBulk()`.** One Redis round-trip per batch instead of one per document.

---

### How phase 2 feeds phase 3

The worker chunks the document and calls ai-inference to get embeddings. Phase 3 builds the inference service that handles that call.

---

## Phase 3 — AI Inference + Adapter

```
services/worker
    │
    │  POST /embed  { chunks, tenantId, jobId }
    ▼
services/ai-inference  (port 3003)
    │
    │  batchChunks() — splits into ≤96 per call
    │
    ▼
packages/ai-adapter
    │
    ├── primary circuit: CLOSED / OPEN / HALF_OPEN
    │       │
    │       │  POST /v1/embeddings
    │       ▼
    │   OpenAI / Voyage AI / any compatible API
    │       │
    │       ▼
    │   sort by index → number[][]
    │
    └── fallback (if primary OPEN)
            │
            ▼
        stub — returns zeros, same dimensions
```

**Circuit breaker state machine:**

```
          5 consecutive failures
CLOSED ─────────────────────────► OPEN
  ▲                                 │
  │  probe succeeds                 │  30s cooldown
  │                                 ▼
  └──────────────────────── HALF_OPEN
         probe fails → OPEN
```

---

### `@docflow/ai-adapter`

Provider-agnostic embedding layer. The worker never knows which API it's talking to.

**Files:**
```
packages/ai-adapter/src/
├── types.ts           ← EmbeddingProvider, AIAdapter, CircuitState interfaces
├── http-provider.ts   ← createHttpProvider() — OpenAI-compatible, 10s timeout
├── stub.ts            ← createStubProvider() — zero vectors, 1536 dimensions
├── circuit-breaker.ts ← createCircuitBreaker() — CLOSED/OPEN/HALF_OPEN state machine
├── adapter.ts         ← createAIAdapter() — primary + fallback routing
└── index.ts
```

**Design choices:**

- **OpenAI-compatible HTTP interface.** Anthropic doesn't have native embeddings. Their embedding product (Voyage AI) uses the same request format as OpenAI. Targeting that format means swapping providers is a config change, not a code change.
- **Circuit opens on 5 consecutive failures, not 5 total.** A flaky provider that mostly works shouldn't trip the circuit. You need 5 failures in a row — the count resets on any success.
- **One probe at a time in HALF_OPEN.** When the cooldown ends, multiple requests can arrive at once. Without a lock, all of them probe simultaneously — a burst hitting a provider that's still recovering. One probe tells you what you need to know.
- **Stub returns zeros, not random vectors.** Random vectors make tests non-reproducible. Zeros are deterministic. Stub uses 1536 dimensions to match the real provider so pgvector's schema works with both.

---

### `@docflow/ai-inference`

HTTP service that wraps the adapter. Workers call this instead of managing their own provider connections.

**Files:**
```
services/ai-inference/src/
├── batcher.ts   ← splits DocumentChunk[] into batches of ≤96
├── routes.ts    ← POST /embed, GET /healthz, GET /readyz
└── index.ts     ← Fastify setup, adapter init, graceful shutdown
```

**Design choices:**

- **Separate service, not a package import.** Workers could import `@docflow/ai-adapter` directly. The problem: 10 worker replicas means 10 independent circuit breakers — one trips while the other 9 keep hammering a struggling provider. One service means one shared circuit state, one connection pool, one place API keys live.
- **`/readyz` reflects circuit state.** Returns 503 when the primary circuit is OPEN. Workers check this before pulling jobs they can't process.

---

### How phase 3 feeds phase 4

The worker calls `inference.embed(chunks)` and gets back `number[][]`. Phase 4 writes those vectors to the correct pgvector shard. The inference interface doesn't change.

---

## Phase 4 — Ingest Service + Storage Ambassador

```
POST /ingest { file, tenantId }
    │
    ▼
ingest-service (3004)
    │  store file → /uploads volume
    │  POST /internal/register
    ▼
pipeline-coordinator (3002)
    │  scheduler.enqueue() → poll every 5s → Redis
    ▼
worker
    │  ambassador.get(source) → chunkText()
    │  POST /embed → ai-inference
    │  writeEmbeddedChunks()
    ▼
PostgreSQL + pgvector
    └── EmbeddedChunk (documentId, tenantId, chunkIndex, embedding vector(1536))
```

**Files:**
```
packages/storage-ambassador/src/
├── types.ts   ← StorageAmbassador interface
└── local.ts   ← createLocalAmbassador(baseDir)

packages/db/
├── prisma/schema.prisma          ← EmbeddedChunk model
├── prisma/migrations/0001_init/  ← CREATE EXTENSION vector + table
└── src/embedded-chunks.ts        ← writeEmbeddedChunks() via $executeRaw

services/ingest-service/src/
├── detect-mime.ts   ← .txt / .md / .pdf → mimeType
└── index.ts         ← POST /ingest, GET /healthz
```

**Design choices:**

- **Storage ambassador, not direct `readFile`.** Worker and ingest service both call `ambassador.get/put` — neither knows if files are on disk or S3. Swapping providers is a config change.
- **`$executeRaw` for vector inserts.** Prisma marks `vector(1536)` as `Unsupported`. Raw SQL passes the vector as `'[...]'::vector` — PostgreSQL handles the cast.
- **202 on registration, not completion.** Ingest returns `{ documentId }` as soon as the job is queued, not after embeddings are written. Blocking until pgvector would make uploads as slow as the full pipeline.
- **Migration as an init container.** `migrate` runs `prisma migrate deploy` and exits before the worker starts.

---

### How phase 4 feeds phase 5

The `EmbeddedChunk` rows written here are what the query service searches. Schema is fixed: `embedding vector(1536)`, indexed by `tenantId`.

---

## Phase 5 — Query Service

```
POST /query { query, tenantId, topK }
    │
    ▼
query-service (3005)
    │  embed query text
    │  POST /embed → ai-inference (3003)
    │  ← number[1536]
    │
    │  scatter ──────────────────────────────┐
    │                                        │
    ▼                  ▼                     ▼
Shard 0            Shard 1              Shard 2
(pgvector)         (pgvector)           (pgvector)
embedding <=>      embedding <=>        embedding <=>
queryVec           queryVec             queryVec
local top-K        local top-K          local top-K
    │                  │                     │
    └──────────────────┴─────────────────────┘
                        │  gather
                        │  merge + re-rank by score
                        │  global top-K
                        ▼
              { results[], durationMs }
```

**Files:**
```
packages/db/src/
└── search-chunks.ts     ← searchEmbeddedChunks() via $queryRaw + <=> operator

services/query-service/src/
├── scatter-gather.ts    ← Promise.allSettled fan-out, merge, re-rank
├── routes.ts            ← POST /query, GET /healthz, GET /readyz
└── index.ts             ← shard clients from SHARD_URLS, graceful shutdown
```

**Design choices:**

- **`Promise.allSettled` instead of `Promise.all` for scatter.** `Promise.all` fails the entire request the moment one shard errors. `Promise.allSettled` waits for every shard and keeps whatever succeeded. If shard 1 is down, you still get results from shards 0 and 2. A degraded response is better than an error.
- **Each shard returns its local top-K before merging.** The naive approach is to ask each shard for 1 result and pick the best. That breaks when the true best result is ranked 3rd on its shard — it never makes it into the merge pool. The fix: each shard returns top-K candidates, then you merge all of them and re-sort globally. More data transferred, but the ranking is correct.
- **Embedding happens in ai-inference, not here.** The query service sends the query text to ai-inference and gets a vector back — same endpoint the workers use. The alternative is giving the query service its own AI client and circuit breaker. That means two independent circuits for the same provider: workers could be on a tripped circuit while the query service keeps hammering it, or vice versa. Sharing one service means one circuit, one connection pool, one place the API key lives.
- **`SHARD_URLS` is a comma-separated list of connection strings.** In development, you set one URL and get one shard. In production, you set three and get three — no code changes, just config. Adding a shard without downtime is just a redeploy of the query service with an updated env var.
- **`::float8` cast on the distance score.** pgvector stores cosine distance as a 32-bit float (`float4`). When Prisma reads it back through the raw query, the type mapping is inconsistent — sometimes it comes back as a string, sometimes a number, depending on the driver version. Casting to `float8` in the SQL forces PostgreSQL to return a 64-bit float, which always maps to a JS `number` cleanly.

---

### How phase 5 feeds phase 6

The query service is the internal search layer. Phase 6 (API gateway) sits in front of it — handles auth, rate limiting, and tenant routing before proxying to `/query`.

---

## Phase 6 — API Gateway

```
client
    │  X-API-Key: dev-key-1
    │  POST /ingest  or  POST /query
    ▼
api-gateway (3000)
    │
    ├── auth middleware
    │     valid key?  → continue
    │     missing/wrong key → 401
    │
    ├── rate limiter (per tenant)
    │     under limit?  → continue
    │     over limit    → 429 + retryAfterMs
    │
    ├── POST /ingest ──────────────► ingest-service (3004)
    │                                     │
    │                                  202 { documentId }
    │                                     │
    └── POST /query ───────────────► query-service (3005)
                                          │
                                       { results[], durationMs }
```

**Files:**
```
services/api-gateway/src/
├── auth.ts          ← createAuthHandler() — X-API-Key header validation
├── rate-limiter.ts  ← createRateLimiter() — per-tenant token bucket
├── routes.ts        ← POST /ingest, POST /query, /healthz, /readyz
├── types.d.ts       ← FastifyRequest augmented with rawBody
└── index.ts         ← Fastify setup, raw body capture, graceful shutdown
```

**Design choices:**

- **Auth runs before rate limiting.** An invalid API key is rejected immediately — the rate limiter never sees the request. This matters because rate limiting is keyed by tenant, and an unauthenticated request has no tenant. Running them in order keeps both pieces simpler.
- **Rate limiting is per tenant, not per IP.** IP-based limiting breaks behind a load balancer — every request looks like it comes from the same IP. Tenant ID is in the request body, so each tenant gets their own independent bucket regardless of where the request originates.
- **In-memory token bucket, not Redis.** Redis-backed rate limiting is consistent across multiple gateway replicas. In-memory is not — if you run three gateway replicas, each has its own counter and a tenant gets 3× the limit. For a single replica this is correct and simpler. Phase 7 (infra) is the right time to swap to Redis if needed.
- **Proxy forwards the raw body verbatim.** Parsing and re-serializing the request body would change it — multipart boundaries would break, JSON formatting might shift. Capturing the raw bytes and forwarding them unchanged means ingest-service and query-service see exactly what the client sent.
- **`/readyz` pings both upstreams.** The gateway is only ready if ingest-service and query-service are both reachable. A gateway that's up but routing to a dead service is worse than a gateway that's marked not ready — Kubernetes will stop sending traffic and let another replica handle it.

---

### How phase 6 feeds phase 7

The gateway is the public entry point. Phase 7 wires up the observability stack (Prometheus, Grafana) and Kubernetes manifests so the whole system is deployable and monitorable.
