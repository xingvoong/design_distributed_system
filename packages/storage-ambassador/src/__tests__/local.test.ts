import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { rm, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalAmbassador } from '../local.js'

describe('createLocalAmbassador', () => {
  let baseDir: string

  beforeAll(async () => {
    baseDir = await mkdtemp(join(tmpdir(), 'storage-test-'))
  })

  afterAll(async () => {
    await rm(baseDir, { recursive: true, force: true })
  })

  it('puts and gets a file by relative key', async () => {
    const ambassador = createLocalAmbassador(baseDir)
    const data = Buffer.from('hello docflow')

    await ambassador.put('tenant-a/doc-1/file.txt', data, 'text/plain')
    const result = await ambassador.get('tenant-a/doc-1/file.txt')

    expect(result.toString('utf-8')).toBe('hello docflow')
  })

  it('creates parent directories automatically on put', async () => {
    const ambassador = createLocalAmbassador(baseDir)
    const data = Buffer.from('nested file')

    await expect(
      ambassador.put('a/b/c/d/file.txt', data, 'text/plain'),
    ).resolves.toBeUndefined()
  })

  it('reads files by absolute path (legacy job.source compatibility)', async () => {
    // Absolute paths bypass baseDir — existing seeder jobs use /data/ml-systems.txt
    const ambassador = createLocalAmbassador(baseDir)
    const data = Buffer.from('absolute path content')

    // Write with relative key, then read back with absolute path
    await ambassador.put('abs-test/file.txt', data, 'text/plain')
    const absPath = join(baseDir, 'abs-test/file.txt')
    const result = await ambassador.get(absPath)

    expect(result.toString('utf-8')).toBe('absolute path content')
  })

  it('throws when getting a non-existent key', async () => {
    const ambassador = createLocalAmbassador(baseDir)
    await expect(ambassador.get('does/not/exist.txt')).rejects.toThrow()
  })
})
