import { describe, it, expect, afterEach } from 'vitest'
import { createLeaderElection } from '../index.js'

// These tests require a running Redis instance.
// Run: docker run -p 6379:6379 redis:7-alpine

const baseConfig = {
  host: process.env['REDIS_HOST'] ?? 'localhost',
  port: Number(process.env['REDIS_PORT'] ?? 6379),
  ttl: 2_000,
  heartbeatInterval: 500,
}

describe('leader election', () => {
  const cleanups: Array<() => Promise<void>> = []

  afterEach(async () => {
    for (const cleanup of cleanups) {
      await cleanup()
    }
    cleanups.length = 0
  })

  it('throws if heartbeatInterval >= ttl', () => {
    expect(() =>
      createLeaderElection({
        ...baseConfig,
        electionKey: 'test-key',
        nodeId: 'node-1',
        ttl: 1_000,
        heartbeatInterval: 1_000,
      }),
    ).toThrow('heartbeatInterval')
  })

  it('single node becomes leader', async () => {
    const election = createLeaderElection({
      ...baseConfig,
      electionKey: `election-${Date.now()}`,
      nodeId: 'node-1',
    })
    cleanups.push(() => election.stop())

    const elected = await new Promise<boolean>((resolve) => {
      election.on('elected', () => resolve(true))
      election.start()
    })

    expect(elected).toBe(true)
    expect(election.isLeader()).toBe(true)
  })

  it('only one node wins when two compete', async () => {
    const key = `election-${Date.now()}`

    const node1 = createLeaderElection({ ...baseConfig, electionKey: key, nodeId: 'node-1' })
    const node2 = createLeaderElection({ ...baseConfig, electionKey: key, nodeId: 'node-2' })
    cleanups.push(() => node1.stop(), () => node2.stop())

    await new Promise<void>((resolve) => {
      let settled = 0
      const done = () => { if (++settled === 2) resolve() }
      node1.on('elected', done)
      node1.on('follower', done)
      node2.on('elected', done)
      node2.on('follower', done)
      node1.start()
      node2.start()
    })

    // Exactly one leader
    const leaders = [node1.isLeader(), node2.isLeader()].filter(Boolean)
    expect(leaders).toHaveLength(1)
  })

  it('follower takes over after leader stops', async () => {
    const key = `election-${Date.now()}`

    const node1 = createLeaderElection({ ...baseConfig, electionKey: key, nodeId: 'node-1' })
    const node2 = createLeaderElection({ ...baseConfig, electionKey: key, nodeId: 'node-2' })
    cleanups.push(() => node2.stop())

    // node1 wins first
    await new Promise<void>((resolve) => {
      node1.on('elected', resolve)
      node1.start()
    })

    expect(node1.isLeader()).toBe(true)

    // node2 starts competing
    node2.start()

    // node1 stops (releases lock)
    await node1.stop()

    // node2 should elect itself within ttl + one interval
    const node2Elected = await new Promise<boolean>((resolve) => {
      node2.on('elected', () => resolve(true))
      setTimeout(() => resolve(false), baseConfig.ttl + baseConfig.heartbeatInterval * 2)
    })

    expect(node2Elected).toBe(true)
    expect(node2.isLeader()).toBe(true)
  })
})
