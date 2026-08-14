import { describe, it, expect, vi } from 'vitest'
import { createCircuitBreaker } from '../circuit-breaker.js'
import type { EmbeddingProvider } from '../types.js'

function makeProvider(name = 'test'): EmbeddingProvider & { fail: () => void; succeed: () => void } {
  let shouldFail = false
  return {
    name,
    fail() { shouldFail = true },
    succeed() { shouldFail = false },
    async embed(texts) {
      if (shouldFail) throw new Error('provider error')
      return texts.map(() => [0])
    },
  }
}

describe('createCircuitBreaker', () => {
  it('starts CLOSED', () => {
    const cb = createCircuitBreaker(makeProvider(), {})
    expect(cb.getState()).toBe('CLOSED')
  })

  it('passes through in CLOSED state', async () => {
    const provider = makeProvider()
    const cb = createCircuitBreaker(provider, {})
    const result = await cb.embed(['a', 'b'])
    expect(result).toHaveLength(2)
  })

  it('resets failure count on any success (non-consecutive failures do not open)', async () => {
    const provider = makeProvider()
    const cb = createCircuitBreaker(provider, { failureThreshold: 3 })

    // 2 failures, then 1 success, then 2 more failures — total 4 but not 3 consecutive
    provider.fail()
    await expect(cb.embed(['a'])).rejects.toThrow()
    await expect(cb.embed(['a'])).rejects.toThrow()
    provider.succeed()
    await cb.embed(['a']) // success resets count
    provider.fail()
    await expect(cb.embed(['a'])).rejects.toThrow()
    await expect(cb.embed(['a'])).rejects.toThrow()

    // 2 consecutive failures after reset — should still be CLOSED
    expect(cb.getState()).toBe('CLOSED')
  })

  it('opens after failureThreshold consecutive failures', async () => {
    const provider = makeProvider()
    const cb = createCircuitBreaker(provider, { failureThreshold: 3 })

    provider.fail()
    await expect(cb.embed(['a'])).rejects.toThrow()
    await expect(cb.embed(['a'])).rejects.toThrow()
    await expect(cb.embed(['a'])).rejects.toThrow()

    expect(cb.getState()).toBe('OPEN')
  })

  it('rejects immediately when OPEN and within cooldown', async () => {
    const provider = makeProvider()
    const cb = createCircuitBreaker(provider, { failureThreshold: 1, cooldownMs: 60_000 })

    provider.fail()
    await expect(cb.embed(['a'])).rejects.toThrow()
    expect(cb.getState()).toBe('OPEN')

    provider.succeed()
    // Should throw immediately — cooldown hasn't elapsed
    await expect(cb.embed(['a'])).rejects.toThrow(/Circuit open/)
    expect(cb.getState()).toBe('OPEN')
  })

  it('transitions to HALF_OPEN after cooldown', async () => {
    const provider = makeProvider()
    const cb = createCircuitBreaker(provider, { failureThreshold: 1, cooldownMs: 10 })

    provider.fail()
    await expect(cb.embed(['a'])).rejects.toThrow()
    expect(cb.getState()).toBe('OPEN')

    await new Promise((r) => setTimeout(r, 20))

    // Next call triggers HALF_OPEN → probe
    provider.succeed()
    await cb.embed(['a'])
    expect(cb.getState()).toBe('CLOSED')
  })

  it('closes on successful probe in HALF_OPEN', async () => {
    const provider = makeProvider()
    const cb = createCircuitBreaker(provider, { failureThreshold: 1, cooldownMs: 10 })

    provider.fail()
    await expect(cb.embed(['a'])).rejects.toThrow()

    await new Promise((r) => setTimeout(r, 20))

    provider.succeed()
    await cb.embed(['a'])
    expect(cb.getState()).toBe('CLOSED')
  })

  it('opens again on failed probe in HALF_OPEN', async () => {
    const provider = makeProvider()
    const cb = createCircuitBreaker(provider, { failureThreshold: 1, cooldownMs: 10 })

    provider.fail()
    await expect(cb.embed(['a'])).rejects.toThrow()

    await new Promise((r) => setTimeout(r, 20))

    // Probe fails too
    await expect(cb.embed(['a'])).rejects.toThrow()
    expect(cb.getState()).toBe('OPEN')
  })

  it('blocks concurrent probes in HALF_OPEN', async () => {
    const provider = makeProvider()
    const cb = createCircuitBreaker(provider, { failureThreshold: 1, cooldownMs: 10 })

    provider.fail()
    await expect(cb.embed(['a'])).rejects.toThrow()

    await new Promise((r) => setTimeout(r, 20))

    // Make provider slow so the first probe is still in flight when second arrives
    let resolve!: () => void
    const probeFinished = new Promise<void>((r) => { resolve = r })
    vi.spyOn(provider, 'embed').mockImplementationOnce(async () => {
      await probeFinished
      return [[ 0 ]]
    })

    const firstProbe = cb.embed(['a'])
    const secondProbe = cb.embed(['a'])

    // Second probe should be rejected with "probe in progress"
    await expect(secondProbe).rejects.toThrow(/probe in progress/)

    resolve()
    await firstProbe
  })
})
