import { Redis } from 'ioredis'
import type { ElectionEvent, LeaderElection, LeaderElectionConfig } from './types.js'

// Lua script for atomic heartbeat:
// Only extend TTL if this node still owns the lock.
// Prevents a slow node from extending a lock it already lost.
const HEARTBEAT_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("pexpire", KEYS[1], ARGV[2])
  else
    return 0
  end
`

// Lua script for atomic release:
// Only delete the key if this node owns it.
// Prevents releasing a lock acquired by a different node after a crash.
const RELEASE_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  else
    return 0
  end
`

export function createLeaderElection(config: LeaderElectionConfig): LeaderElection {
  const ttl = config.ttl ?? 10_000
  const interval = config.heartbeatInterval ?? 3_000

  if (interval >= ttl) {
    throw new Error(
      `heartbeatInterval (${interval}ms) must be less than ttl (${ttl}ms)`,
    )
  }

  const redis = new Redis({
    host: config.host,
    port: config.port,
    password: config.password,
    maxRetriesPerRequest: null,
  })

  const listeners = new Map<ElectionEvent, Set<() => void>>([
    ['elected', new Set()],
    ['revoked', new Set()],
    ['follower', new Set()],
  ])

  let leader = false
  let timer: ReturnType<typeof setInterval> | null = null
  let running = false

  function emit(event: ElectionEvent) {
    listeners.get(event)?.forEach((fn) => fn())
  }

  async function tryAcquire(): Promise<boolean> {
    // SET key nodeId PX ttl NX — atomic: only sets if key does not exist
    const result = await redis.set(
      config.electionKey,
      config.nodeId,
      'PX',
      ttl,
      'NX',
    )
    return result === 'OK'
  }

  async function heartbeat(): Promise<boolean> {
    const result = await redis.eval(
      HEARTBEAT_SCRIPT,
      1,
      config.electionKey,
      config.nodeId,
      String(ttl),
    )
    return result === 1
  }

  async function release(): Promise<void> {
    await redis.eval(RELEASE_SCRIPT, 1, config.electionKey, config.nodeId)
  }

  async function tick() {
    if (!running) return

    if (leader) {
      // Already leader — renew the lock
      const renewed = await heartbeat()
      if (!renewed) {
        // Lock was taken by another node (split-brain recovery)
        leader = false
        emit('revoked')
      }
    } else {
      // Not leader — compete for the lock
      const acquired = await tryAcquire()
      if (acquired) {
        leader = true
        emit('elected')
      } else {
        emit('follower')
      }
    }
  }

  return {
    start() {
      if (running) return
      running = true
      // Run immediately, then on interval
      void tick()
      timer = setInterval(() => void tick(), interval)
    },

    async stop() {
      running = false
      if (timer) {
        clearInterval(timer)
        timer = null
      }
      if (leader) {
        await release()
        leader = false
        emit('revoked')
      }
      await redis.quit()
    },

    isLeader() {
      return leader
    },

    on(event, handler) {
      listeners.get(event)?.add(handler)
    },

    off(event, handler) {
      listeners.get(event)?.delete(handler)
    },
  }
}
