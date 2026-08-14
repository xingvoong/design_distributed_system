# DocFlow
**Document Intelligence Infrastructure**

A horizontally scalable platform that ingests documents at any volume, processes them through an AI pipeline, and serves sub-100ms semantic search across a sharded vector store.

---

## The problem it solves

Retrieval doesn't scale by default. A single-node vector store degrades as the corpus grows. A single worker falls over under bursty ingestion. One AI provider outage takes the whole system down. DocFlow is infrastructure built to handle all three.

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
4. **Ingest service + storage ambassador** — full ingestion path live
5. **Query service** — scatter/gather search across shards
6. **API gateway** — public surface, auth, rate limiting
7. **Infra** — observability stack, Kubernetes manifests
8. **Load tests** — validate the scale targets are real

---

## Phase 1 — Queue + Leader Election

### `@docflow/queue`

Producer puts jobs in. Consumer pulls jobs out. Redis sits in the middle and holds the queue.

```
Producer → Redis → Consumer
```

- Workers **pull** — they ask Redis for the next job when ready. Redis never pushes.
- `stop()` finishes the job in hand before shutting down. Never drops work mid-flight.
- `addBulk()` writes all jobs in one call. Cheaper than looping over `add()`.

**Files:**
```
packages/queue/src/
├── types.ts      ← Producer, Consumer, QueueConfig interfaces
├── producer.ts   ← createProducer<T>() — add, addBulk, close
├── consumer.ts   ← createConsumer<T>() — start, stop (graceful drain)
└── index.ts
```

---

### `@docflow/leader-election`

Multiple nodes all try to write the same key to Redis. Redis only lets one win — that's the lock. The winner is leader.

- The leader refreshes the lock every 500ms. If it dies, the lock expires after 2 seconds and another node wins.
- Heartbeat and release are Lua scripts — the check and the action happen in one atomic step. No race condition possible.
- Nodes emit events: `elected`, `follower`, `revoked`. Your code reacts to those.

**Files:**
```
packages/leader-election/src/
├── types.ts     ← LeaderElection, LeaderElectionConfig, ElectionEvent
├── election.ts  ← createLeaderElection() — SET NX PX + Lua heartbeat/release
└── index.ts
```

---

### How phase 1 feeds phase 2

Phase 2 builds two things on top:

- **Worker** — calls `createConsumer()`, processes documents
- **Pipeline Coordinator** — calls `createLeaderElection()`, ensures only one node schedules jobs at a time

Nothing in phase 1 changes from here forward.

---

## Phase 2 — Worker + Pipeline Coordinator

### `@docflow/worker`

Pulls document jobs from the queue, extracts text, splits it into chunks, and hands the result to phase 3 for embedding.

- `processDocument()` reads the file and routes it through `extractText()` based on MIME type. PDF binary parsing is a phase 3 concern — for now the pipeline stays runnable end-to-end.
- `chunkText()` splits on sentence boundaries to avoid cutting mid-thought. Each chunk overlaps with the previous by 64 tokens — this preserves context at chunk edges when doing retrieval.
- `stop()` signals the consumer to drain in-flight jobs before the process exits. Kubernetes sends `SIGTERM` before killing the pod — this gives workers time to finish without dropping work.
- `/healthz` and `/readyz` are separate endpoints. Liveness tells Kubernetes the process is alive. Readiness tells it whether to send traffic. The worker marks itself not-ready during shutdown so the load balancer stops routing jobs to it.

**Files:**
```
services/worker/src/
├── chunker.ts     ← splits text into overlapping chunks, sentence-aware
├── processor.ts   ← reads file, extracts text, calls chunker
├── health.ts      ← /healthz and /readyz for Kubernetes probes
└── index.ts       ← wires consumer + health + graceful shutdown
```

---

### `@docflow/pipeline-coordinator`

Wins leader election, then schedules document jobs into the queue. Stands by silently as a follower.

- Only the leader runs the scheduler. If the leader crashes, a new one is elected within the TTL window and the scheduler starts on that node. No duplicate scheduling, no gap in scheduling.
- The scheduler batches up to 50 documents per poll tick using `addBulk()`. One Redis round-trip per batch instead of one per document.
- Follower nodes stay running and connected to Redis — they're ready to take over immediately if the leader goes down.
- In phase 4, the scheduler will query Postgres for pending documents. For now it holds them in memory so the pipeline is runnable without a database.

**Files:**
```
services/pipeline-coordinator/src/
├── scheduler.ts   ← polls for pending docs, enqueues jobs in batches of 50
└── index.ts       ← leader election + scheduler + health + graceful shutdown
```

---

### How phase 2 feeds phase 3

The worker finishes processing and has a list of `DocumentChunk[]`. It calls the ai-inference service, gets back vectors, and logs them. Phase 4 picks up from there — writes those vectors to the sharded pgvector store.

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
    │       │  { data: [{ embedding, index }] }
    │       ▼
    │   sort by index → number[][]
    │
    └── fallback circuit (if primary OPEN)
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

Provider-agnostic embedding layer. The worker never knows which company's API it's talking to.

- `createHttpProvider()` calls any OpenAI-compatible embedding endpoint — OpenAI, Voyage AI, or a local model. Swapping providers is a config change, not a code change.
- `createCircuitBreaker()` wraps any provider. Opens after 5 consecutive failures, waits 30s, then probes with a single request. Only one probe goes through at a time — no thundering herd on recovery.
- `createStubProvider()` returns zero vectors at 1536 dimensions. Zeros are deterministic so tests are reproducible. 1536 matches `text-embedding-3-small` so pgvector's schema works with both.
- `createAIAdapter()` routes requests — primary if its circuit is closed, fallback otherwise. The `circuitState()` method surfaces primary health for the readiness probe.

**Files:**
```
packages/ai-adapter/src/
├── types.ts           ← EmbeddingProvider, AIAdapter, CircuitState interfaces
├── http-provider.ts   ← createHttpProvider() — OpenAI-compatible, 10s timeout, sorts by index
├── stub.ts            ← createStubProvider() — zero vectors, 1536 dimensions
├── circuit-breaker.ts ← createCircuitBreaker() — CLOSED/OPEN/HALF_OPEN state machine
├── adapter.ts         ← createAIAdapter() — primary + fallback routing
└── index.ts
```

---

### `@docflow/ai-inference`

HTTP service that wraps the adapter. Workers call this instead of managing their own provider connections.

- `POST /embed` — accepts chunks, batches them into groups of ≤96, calls the adapter per batch, returns all embeddings in input order.
- `GET /readyz` — returns 503 if the primary circuit is OPEN. Workers can check this before pulling jobs they can't process.
- `GET /healthz` — always 200 if the process is alive. Separate from readiness so Kubernetes doesn't kill a pod just because a provider is down.

**Files:**
```
services/ai-inference/src/
├── batcher.ts   ← splits DocumentChunk[] into batches of ≤96
├── routes.ts    ← POST /embed, GET /healthz, GET /readyz
└── index.ts     ← Fastify setup, adapter init, graceful shutdown
```

---

### Why a separate service instead of importing the package directly

Workers could import `@docflow/ai-adapter` and call it inline. The problem: 10 worker replicas means 10 independent circuit breakers. One replica trips, the other 9 keep hammering a struggling provider. A single `ai-inference` service means one shared circuit state, one connection pool, one place API keys live.

---

### How phase 3 feeds phase 4

The worker now calls `inference.embed(chunks)` and gets back `number[][]`. Phase 4 takes those vectors and writes them to the correct pgvector shard. The inference service interface doesn't change.
