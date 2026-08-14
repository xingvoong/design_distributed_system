import { describe, it, expect } from 'vitest'
import { createStubProvider } from '../stub.js'

describe('createStubProvider', () => {
  const provider = createStubProvider()

  it('has name "stub"', () => {
    expect(provider.name).toBe('stub')
  })

  it('returns one vector per input text', async () => {
    const result = await provider.embed(['hello', 'world', 'foo'])
    expect(result).toHaveLength(3)
  })

  it('returns 1536-dimensional vectors', async () => {
    const result = await provider.embed(['test'])
    expect(result[0]).toHaveLength(1536)
  })

  it('fills all values with zero', async () => {
    const result = await provider.embed(['test'])
    expect(result[0]!.every((v) => v === 0)).toBe(true)
  })

  it('handles a single text', async () => {
    const result = await provider.embed(['only one'])
    expect(result).toHaveLength(1)
  })
})
