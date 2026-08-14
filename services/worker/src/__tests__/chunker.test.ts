import { describe, it, expect } from 'vitest'
import { chunkText } from '../chunker.js'

describe('chunkText', () => {
  it('returns a single chunk for short text', () => {
    const chunks = chunkText('Hello world.', 'doc-1', 'tenant-a')
    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.text).toBe('Hello world.')
    expect(chunks[0]?.chunkIndex).toBe(0)
  })

  it('assigns correct documentId and tenantId to every chunk', () => {
    const chunks = chunkText('Hello world.', 'doc-42', 'tenant-b')
    for (const chunk of chunks) {
      expect(chunk.documentId).toBe('doc-42')
      expect(chunk.tenantId).toBe('tenant-b')
    }
  })

  it('splits long text into multiple chunks', () => {
    // Build text well over the 512 token (~2048 char) limit
    const sentence = 'This is a sentence that adds to the token count. '
    const longText = sentence.repeat(100)

    const chunks = chunkText(longText, 'doc-1', 'tenant-a')
    expect(chunks.length).toBeGreaterThan(1)
  })

  it('chunk indices are sequential', () => {
    const sentence = 'This is a sentence that adds to the token count. '
    const longText = sentence.repeat(100)

    const chunks = chunkText(longText, 'doc-1', 'tenant-a')
    chunks.forEach((chunk, i) => {
      expect(chunk.chunkIndex).toBe(i)
    })
  })

  it('every chunk has a positive token count', () => {
    const sentence = 'This is a sentence that adds to the token count. '
    const longText = sentence.repeat(100)

    const chunks = chunkText(longText, 'doc-1', 'tenant-a')
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeGreaterThan(0)
    }
  })

  it('handles empty string without crashing', () => {
    const chunks = chunkText('', 'doc-1', 'tenant-a')
    expect(chunks).toHaveLength(0)
  })
})
