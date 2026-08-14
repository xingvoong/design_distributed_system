export interface StorageAmbassador {
  /** Fetch a stored file by its key. Returns raw bytes. */
  get(key: string): Promise<Buffer>
  /** Write a file. key is the storage path / object key. */
  put(key: string, data: Buffer, mimeType: string): Promise<void>
}
