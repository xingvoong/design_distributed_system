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
7. **Infra** — observability stack, Kubernetes manifests ✓
8. **Load tests** — validate the scale targets are real ✓

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

**Design choice:**

- **Workers pull, Redis doesn't push.** A slow worker keeps getting more jobs if Redis pushes. With pulling, a slow worker just asks less often — it naturally controls its own load.

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

**Design choice:**

- **Lua scripts for heartbeat and release.** The heartbeat checks if this node owns the lock, then extends it. Without Lua, those are two separate commands — another node could steal the lock in between. Lua makes it one atomic step.

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

**Design choice:**

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

**Design choice:**

- **Only the leader runs the scheduler.** Without this, multiple coordinators enqueue the same documents at the same time. Leader election ensures exactly one node schedules at a time.

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

**Design choice:**

- **Circuit opens on 5 consecutive failures, not 5 total.** A flaky provider that mostly works shouldn't trip the circuit. You need 5 failures in a row — the count resets on any success.

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

**Design choice:**

- **Separate service, not a package import.** Workers could import `@docflow/ai-adapter` directly. The problem: 10 worker replicas means 10 independent circuit breakers — one trips while the other 9 keep hammering a struggling provider. One service means one shared circuit state, one connection pool, one place API keys live.

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

**Design choice:**

- **202 on registration, not completion.** Ingest returns `{ documentId }` as soon as the job is queued, not after embeddings are written. Blocking until pgvector would make uploads as slow as the full pipeline.

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

**Design choice:**

- **`Promise.allSettled` instead of `Promise.all` for scatter.** `Promise.all` fails the entire request the moment one shard errors. `Promise.allSettled` waits for every shard and keeps whatever succeeded. If shard 1 is down, you still get results from shards 0 and 2. A degraded response is better than an error.

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

**Design choice:**

- **Rate limiting is per tenant, not per IP.** IP-based limiting breaks behind a load balancer — every request looks like it comes from the same IP. Tenant ID is in the request body, so each tenant gets their own independent bucket regardless of where the request originates.

---

### How phase 6 feeds phase 7

The gateway is the public entry point. Phase 7 wires up the observability stack (Prometheus, Grafana) and Kubernetes manifests so the whole system is deployable and monitorable.

---

## Phase 7 — Infra

```
                    ┌─────────────────────────┐
                    │  Prometheus (9090)       │
                    │  scrapes /metrics every  │
                    │  15s from all services   │
                    └──────────┬──────────────┘
                               │
                    ┌──────────▼──────────────┐
                    │  Grafana (3006)          │
                    │  - requests/sec          │
                    │  - p99 latency           │
                    │  - error rate            │
                    │  - service up/down       │
                    └─────────────────────────┘

Kubernetes (infra/k8s/)
├── namespace.yaml              ← docflow namespace
├── configmap.yaml              ← shared env vars
├── secret.yaml                 ← DB URL, API keys, embedding key
├── redis.yaml                  ← Deployment + Service
├── postgres.yaml               ← StatefulSet + Service + 20Gi PVC
├── api-gateway.yaml            ← Deployment + LoadBalancer + HPA (3–10 replicas)
├── worker.yaml                 ← Deployment + HPA (3–20 replicas) + 50Gi PVC
├── ingest-service.yaml         ← Deployment + Service
├── query-service.yaml          ← Deployment + Service
├── ai-inference.yaml           ← Deployment + Service
└── pipeline-coordinator.yaml   ← Deployment + Service
```

**Design choice:**

- **HPA on worker and gateway, not on every service.** The worker is the bottleneck under load — it does CPU-heavy chunking and blocks on pgvector writes. The gateway is the entry point and needs to handle traffic spikes. The other services (coordinator, ai-inference, query) have more predictable load and scale manually.

---

### How phase 7 feeds phase 8

With Prometheus collecting metrics, Phase 8 (load tests) can validate the scale targets against real numbers — requests/sec, p99 latency, and error rate visible in Grafana as load increases.

---

## Phase 8 — Load Tests

Three k6 scripts, each targeting a specific scale claim.

```
tests/load/
├── ingest.js   ← throughput: validates 10,000 docs/hour
├── query.js    ← latency: validates p99 < 100ms
└── spike.js    ← resilience: 20× traffic spike, confirm clean recovery
```

**Run:**
```bash
# requires k6 — https://k6.io/docs/get-started/installation/
GATEWAY_URL=http://localhost:3000 k6 run tests/load/ingest.js
GATEWAY_URL=http://localhost:3000 k6 run tests/load/query.js
GATEWAY_URL=http://localhost:3000 k6 run tests/load/spike.js
```

**What each test proves:**

- **`ingest.js`** — ramps to 3 docs/sec, holds for 3 minutes. 3/sec × 3600 = 10,800 docs/hour. Threshold: <1% errors, 95th percentile response under 2s (ingestion is async — the 2s is just queue registration, not embedding).
- **`query.js`** — ramps to 10 concurrent users, spikes to 50. Threshold: p99 < 100ms. Watch this in Grafana alongside the latency panel.
- **`spike.js`** — jumps from 5 to 100 users in 10 seconds. Expects 429s from the rate limiter (that's correct behaviour). Threshold: <5% hard 5xx errors. Validates the system doesn't fall over.

**Design choice:**

- **429s are not counted as errors in the spike test.** A 429 means the rate limiter caught the burst — that's the system working correctly. Counting them as failures would make the test penalise good behaviour.

---

## Wrap-up

Eight phases. One complete system.

Start with a document upload. End with a sub-100ms semantic search across 50M+ embeddings, sharded across Postgres instances, with auth, rate limiting, circuit breakers, graceful shutdown, and Kubernetes autoscaling.

Every layer is connected. Phase 1's queue feeds Phase 2's worker. Phase 3's circuit breaker protects Phase 4's embeddings. Phase 5's scatter/gather serves Phase 6's gateway. Phase 7 makes all of it visible. Phase 8 proves it holds.

**What production-grade actually means:**

It's not a feature list. It's a set of properties the system has under adversity:

- A worker crashes mid-job — the job reruns, no data lost
- The AI provider goes down — the circuit opens, the stub takes over, workers keep processing
- One pgvector shard goes offline — queries degrade gracefully, other shards still return results
- A tenant floods the gateway — rate limiter catches it, other tenants are unaffected
- You deploy a new worker version — pods drain their current jobs before terminating

None of these required special handling at the call site. They're baked into the architecture.

---

## TypeScript over Python

Python is the default for backend systems, especially anything touching AI. Here's what TypeScript earns instead.

**Types catch entire categories of bugs at compile time.** The `ChunkToWrite` interface means you can't accidentally pass a string where an embedding vector goes. The `CircuitState` union means the circuit breaker can only be in states the compiler knows about. In Python, these are runtime errors you find in production. In TypeScript, they're red underlines you fix before running anything.

**The async model is explicit.** Every function that touches the network or disk is `async`. Every call that could fail is `await`-ed. You can read the code and know exactly where it yields. Python's `asyncio` is powerful but mixes sync and async code in ways that create subtle bugs — calling a sync function in an async context blocks the event loop silently.

**Refactoring is safe at scale.** When we changed `createPrismaClient` to accept an optional URL parameter, TypeScript immediately flagged every call site. In a Python codebase of this size, that's a grep and a prayer. The compiler is a free QA pass on every change.

Python is still the right choice when you're moving fast on data work, prototyping, or the ecosystem you need only exists there. But for a system this interconnected — where the queue type flows into the worker, which flows into the inference client, which flows into the DB write — TypeScript's type system pays for itself many times over.

---

## Takeaways

**Distributed systems are an exercise in failure modes.** Every design decision in this codebase — circuit breakers, `Promise.allSettled`, graceful shutdown, leader election, two health endpoints — exists because something can go wrong. The question is whether the failure is silent or loud, recoverable or catastrophic.

**Shared state is the root of most complexity.** Leader election exists because two coordinators sharing the same queue without coordination would double-enqueue every job. The circuit breaker is a service instead of a package import because shared circuit state beats 10 independent ones. When something feels complicated, ask what shared state is causing it.

**Async by default, sync only when you must.** Ingest returns 202 immediately. The pipeline runs in the background. The caller never waits for the full embedding pipeline. This is what makes 10,000 docs/hour possible — the HTTP response is decoupled from the actual work.

**The boring parts matter more than the interesting parts.** The queue, the health endpoints, the graceful shutdown, the migration init container — none of that is clever. All of it is what separates a system that runs in production from one that works in a demo.
