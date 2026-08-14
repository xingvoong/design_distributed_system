export interface LeaderElectionConfig {
  host: string
  port: number
  password?: string
  /** Unique name for this election — all competing nodes use the same key */
  electionKey: string
  /** Unique id for this node */
  nodeId: string
  /**
   * How long the lock lives in Redis without a heartbeat (ms).
   * If the leader crashes, a new election starts after this TTL expires.
   * Default: 10_000
   */
  ttl?: number
  /**
   * How often to attempt acquiring or renewing the lock (ms).
   * Must be less than ttl to prevent accidental expiry.
   * Default: 3_000
   */
  heartbeatInterval?: number
}

export type ElectionEvent = 'elected' | 'revoked' | 'follower'

export interface LeaderElection {
  /** Start competing for leadership */
  start(): void
  /** Release the lock (if held) and stop competing */
  stop(): Promise<void>
  /** True if this node currently holds the lock */
  isLeader(): boolean
  /** Register a callback for election state changes */
  on(event: ElectionEvent, handler: () => void): void
  off(event: ElectionEvent, handler: () => void): void
}
