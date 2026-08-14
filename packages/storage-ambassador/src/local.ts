import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { StorageAmbassador } from './types.js'

/**
 * Local-disk implementation.
 * get(key) → reads baseDir/key as a file path (or key as an absolute path
 *             when it starts with '/', so existing jobs with absolute sources
 *             continue to work unchanged).
 * put(key) → writes to baseDir/key, creating parent directories as needed.
 */
export function createLocalAmbassador(baseDir: string): StorageAmbassador {
  return {
    async get(key: string): Promise<Buffer> {
      const path = key.startsWith('/') ? key : join(baseDir, key)
      return readFile(path)
    },

    async put(key: string, data: Buffer): Promise<void> {
      const path = key.startsWith('/') ? key : join(baseDir, key)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, data)
    },
  }
}
