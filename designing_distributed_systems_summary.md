# Designing Distributed Systems, 2nd Edition
**By Brendan Burns**

---

## What it's about

Burns (co-creator of Kubernetes) argues that distributed systems lack the pattern vocabulary that software engineering developed for single-machine code. This book borrows the "design patterns" concept and applies it to distributed architectures. The goal: give engineers a shared language and reusable blueprints.

---

## PREFACE

Burns's core argument: distributed systems are hard because we lack shared vocabulary. This book is a pattern language — like Gang of Four, but for distributed architecture.

---

## PART I — Foundational Concepts

### Ch 1: Introduction
Why patterns matter. Containers as the unit of abstraction.

```
Old world:             New world:
┌─────────────┐        ┌──────────┐  ┌──────────┐
│  Monolith   │   →    │Container │  │Container │
│  (one big   │        │    A     │  │    B     │
│   binary)   │        └──────────┘  └──────────┘
└─────────────┘         composable, isolated, portable
```

### Ch 2: Important Distributed System Concepts
The vocabulary you need before anything else.

| Concept | What it means |
|---|---|
| Replication | Same data/service on multiple nodes |
| Consistency | All nodes see the same data at the same time |
| Availability | System responds even when nodes fail |
| Partition Tolerance | System works despite network splits |
| CAP Theorem | You can only guarantee 2 of the 3 above |

```
CAP Triangle:
        Consistency
            △
           / \
          /   \
         /     \
Availability───Partition
               Tolerance

Pick any two. Distributed systems live in the CP or AP corner.
```

---

## PART II — Single-Node Patterns

### Ch 3: Sidecar Pattern
```
┌──────────────────────────────┐
│          Pod / Node          │
│  ┌──────────┐  ┌──────────┐  │
│  │   App    │  │ Sidecar  │  │
│  │          │↔ │  - logs  │  │
│  │  (write  │  │  - TLS   │  │
│  │  your    │  │  - sync  │  │
│  │  logic)  │  │  - proxy │  │
│  └──────────┘  └──────────┘  │
│    shared filesystem/network │
└──────────────────────────────┘
```
Key idea: add capability to a container without modifying it. Sidecar is reusable across apps.

---

### Ch 4: Ambassadors
```
┌──────────────────────────────────────┐
│                 Pod                  │
│  ┌──────────┐    ┌────────────────┐  │
│  │   App    │───→│  Ambassador    │──┼──→ Prod DB
│  │ connects │    │  - env routing │  │
│  │ localhost│    │  - sharding    │──┼──→ Test DB
│  └──────────┘    │  - retries     │  │
│                  └────────────────┘  │
└──────────────────────────────────────┘
```
App doesn't know which environment it's in. Ambassador handles routing logic.

---

### Ch 5: Adapters
```
Service A  (Prometheus format) ──┐
Service B  (StatsD format)    ──→│ Adapter │──→ Unified monitoring system
Service C  (custom format)    ──┘
```
Invert of ambassador. Normalizes output instead of abstracting input. Classic use case: heterogeneous monitoring.

---

## PART III — Serving Patterns

### Ch 6: Replicated Load-Balanced Services
```
         ┌──────────────┐
Users ──→ │ Load Balancer│
         └──────┬───────┘
    ┌───────────┼───────────┐
    ↓           ↓           ↓
┌───────┐   ┌───────┐   ┌───────┐
│  R1   │   │  R2   │   │  R3   │
│(stateless) (stateless) (stateless)
└───────┘   └───────┘   └───────┘

Scale: add replicas. Any node handles any request.
```
Works only when stateless. Session state must live elsewhere (Redis, etc).

---

### Ch 7: Sharded Services
```
         ┌──────────────┐
Users ──→ │Shard Router  │ (consistent hashing)
         └──────┬───────┘
    ┌───────────┼───────────┐
    ↓           ↓           ↓
┌───────┐   ┌───────┐   ┌───────┐
│Shard 1│   │Shard 2│   │Shard 3│
│user:A-F│  │user:G-M│  │user:N-Z│
└───────┘   └───────┘   └───────┘

Scale: add shards, re-balance data.
```
Stateful. Each shard owns its slice. Router must know the mapping.

---

### Ch 8: Scatter/Gather
```
         ┌──────────┐
User ───→ │   Root   │ ← aggregates results
         └────┬─────┘
   ┌──────────┼──────────┐
   ↓          ↓          ↓
┌──────┐  ┌──────┐  ┌──────┐
│Leaf 1│  │Leaf 2│  │Leaf 3│  ← parallel workers
└──────┘  └──────┘  └──────┘

Latency = slowest leaf (tail latency problem)
```
Used in: search engines, recommendation systems, distributed SQL.

---

### Ch 9: Functions and Event-Driven Processing
```
Event Source
(HTTP, queue, timer)
      │
      ↓
┌───────────┐
│  Function │  ← short-lived, stateless
│  (FaaS)   │
└─────┬─────┘
      ↓
Output / Side Effect
(DB write, another event, response)
```
Scale to zero when idle. Pay per invocation. Tradeoff: cold starts, hard to debug.

---

### Ch 10: Ownership Election
```
Start: 3 nodes, no leader
┌──────┐  ┌──────┐  ┌──────┐
│ Node1│  │ Node2│  │ Node3│
└──────┘  └──────┘  └──────┘

After election:
┌──────┐  ┌──────┐  ┌──────┐
│Leader│  │Follow│  │Follow│
│ (R/W)│  │ (R)  │  │ (R)  │
└──────┘  └──────┘  └──────┘
     ↑
  heartbeat — if this stops, re-elect
```
Algorithms: Raft, Paxos, Zookeeper. Critical for databases, message brokers, any stateful cluster.

---

## PART IV — Batch Computational Patterns

### Ch 11: Work Queue Systems
```
Producer          Queue             Workers
┌────────┐    ┌──────────┐    ┌──────────┐
│ Job    │───→│ job1     │───→│ Worker 1 │
│ Source │    │ job2     │───→│ Worker 2 │
└────────┘    │ job3     │───→│ Worker 3 │
              └──────────┘    └──────────┘

Workers pull when ready. Queue buffers spikes.
```
Decouples rate of production from rate of consumption.

---

### Ch 12: Event-Driven Batch Processing
```
Raw Data
   │
   ↓
┌──────┐    ┌──────┐    ┌──────┐    ┌────────┐
│Stage1│───→│Stage2│───→│Stage3│───→│ Output │
│(ingest)   │(transform)│(enrich)   │(store) │
└──────┘    └──────┘    └──────┘    └────────┘

Each stage emits events consumed by the next.
Failure in Stage 2 doesn't kill Stage 1.
```
Composable pipelines. Each stage independently scalable.

---

### Ch 13: Coordinated Batch Processing
```
Input Dataset
┌─────────────────────────┐
│ p1  │ p2  │ p3  │ p4   │  ← partition
└──┬──┘└──┬──┘└──┬──┘└──┬──┘
   ↓      ↓      ↓      ↓
 Map    Map    Map    Map    ← parallel
   ↓      ↓      ↓      ↓
  k,v    k,v    k,v    k,v
   └──────┴──────┴──────┘
              ↓
           Reduce             ← aggregate
              ↓
           Result
```
Classic MapReduce. Also covers join patterns, multi-stage coordination.

---

## PART V — Universal Concepts

### Ch 14: Monitoring and Observability
The three pillars:
```
┌─────────────┬──────────────┬──────────────┐
│   Metrics   │    Logs      │   Traces     │
│             │              │              │
│ cpu: 87%    │ ERROR 502    │ req──→svc A  │
│ latency:    │ [timestamp]  │      └──→DB  │
│ p99=340ms   │ user_id=123  │         ↓    │
│             │ path=/api    │      ←──←←←  │
│ (what)      │ (why)        │ (where slow) │
└─────────────┴──────────────┴──────────────┘
```
You can't fix what you can't see. Build this in from day one.

---

### Ch 15: AI Inference and Serving
New in 2nd edition. Serving ML models is just a specialized serving pattern.
```
Request
   │
   ↓
┌──────────────────────────┐
│     Inference Server     │
│  ┌────────┐ ┌─────────┐  │
│  │ Model  │ │Batching │  │
│  │(weights│ │ Queue   │  │
│  │in GPU  │ │(group   │  │
│  │memory) │ │requests)│  │
│  └────────┘ └─────────┘  │
└──────────────────────────┘
   │
   ↓
Prediction / Response

Key tradeoff: latency vs. throughput (batch size)
```

---

### Ch 16: Common Failure Patterns
```
Cascading Failure:
A fails → B overwhelmed → B fails → C overwhelmed → C fails
┌───┐     ┌───┐     ┌───┐
│ A │──×──│ B │──×──│ C │
└───┘     └───┘     └───┘

Fix: Circuit Breaker
┌───┐   ┌──────────┐   ┌───┐
│ A │──→│ Circuit  │──→│ B │
└───┘   │ Breaker  │   └───┘
        │(open if B│
        │ is slow) │
        └──────────┘
```

Other failure modes:
- **Split brain** — two leaders think they're in charge
- **Thundering herd** — all clients retry at once after an outage
- **Slow resource exhaustion** — memory leak that takes days to surface

---

## The Full Map
```
┌─────────────────────────────────────────────────┐
│              Your Distributed System            │
│                                                 │
│  ┌─────────────────────────────────────────┐   │
│  │  Universal: Observability + Failure     │   │
│  └─────────────────────────────────────────┘   │
│                      ↕                          │
│  ┌──────────────┐  ┌──────────────────────┐    │
│  │ Serving      │  │ Batch                │    │
│  │ Load Balance │  │ Work Queues          │    │
│  │ Sharding     │  │ Event Pipelines      │    │
│  │ Scatter/Gather│ │ MapReduce            │    │
│  │ FaaS         │  └──────────────────────┘    │
│  │ Leader Elect │                              │
│  └──────────────┘                              │
│                      ↕                          │
│  ┌─────────────────────────────────────────┐   │
│  │  Single Node: Sidecar / Ambassador /    │   │
│  │  Adapter  ← containers as primitives   │   │
│  └─────────────────────────────────────────┘   │
└─────────────────────────────────────────────────┘
```

Every pattern in this book is a reusable answer to a recurring problem. The goal is to stop solving the same problems from scratch and start composing known solutions.
