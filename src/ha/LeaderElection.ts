import { v4 as uuidv4 } from 'uuid';
import { ILeadershipStorage } from './ILeadershipStorage.js';

interface LeaderElectionOptions {
  heartbeatIntervalMs: number;      // How often to send heartbeats
  electionPollingIntervalMs: number; // How often to try to acquire leadership
  lockTtlSeconds: number;           // How long a lock can be held without heartbeat
  lockId?: string;                  // Optional custom lock ID
  onBecomeLeader?: () => void;      // Optional callback when becoming leader
  onLoseLeadership?: () => void;    // Optional callback when losing leadership
}

/**
 * Implements leader election using a storage for high availability.
 * Only one server instance will be the active leader at any time.
 * If the leader fails, another standby instance will automatically take over.
 */
export class LeaderElection {
  private readonly LOCK_ID: string;
  private readonly HEARTBEAT_INTERVAL: number;
  private readonly ELECTION_POLLING_INTERVAL: number;
  private readonly LOCK_TTL_SECONDS: number;
  private readonly SERVER_ID = uuidv4(); // Simple unique ID
  
  private isLeader = false;
  private heartbeatInterval?: NodeJS.Timeout;
  private electionPollingInterval?: NodeJS.Timeout;
  private isRunning = false;
  private onBecomeLeaderCallback?: () => void;
  private onLoseLeadershipCallback?: () => void;

  /**
   * Creates a new LeaderElection instance
   * @param storage Storage for leadership operations
   * @param options Configuration options for leader election
   */
  constructor(
    private readonly storage: ILeadershipStorage,
    options: LeaderElectionOptions
  ) {
    this.LOCK_ID = options.lockId || 'leader_lock';
    this.HEARTBEAT_INTERVAL = options.heartbeatIntervalMs;
    this.ELECTION_POLLING_INTERVAL = options.electionPollingIntervalMs;
    this.LOCK_TTL_SECONDS = options.lockTtlSeconds;
    
    this.onBecomeLeaderCallback = options.onBecomeLeader;
    this.onLoseLeadershipCallback = options.onLoseLeadership;
    this.storage.setupTTLIndex(this.LOCK_TTL_SECONDS).catch(error => {
      console.error('Failed to setup TTL index for leader election:', error);
    });
  }

  /**
   * Start the leader election process
   */
  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    
    console.log(`Starting leader election process`);
    
    // First attempt to acquire leadership
    await this.tryAcquireLeadership();
    
    // Start polling for leadership
    this.startElectionPolling();
  }

  /**
   * Try to acquire leadership
   */
  private async tryAcquireLeadership(): Promise<boolean> {
    try {
      const acquired = await this.storage.tryAcquireLock(this.LOCK_ID, this.SERVER_ID);

      if (acquired) {
        if (!this.isLeader) {
          console.log(`Server became leader`);
          this.isLeader = true;
          this.startHeartbeat();
          
          if (this.onBecomeLeaderCallback) {
            this.onBecomeLeaderCallback();
          }
        }
        return true;
      } else if (this.isLeader) {
        // We thought we were leader but we're not
        console.log(`Server lost leadership`);
        this.stepDown();
      }
      
      return false;
    } catch (error) {
      console.error('Error during leader election:', error);
      if (this.isLeader) {
        this.stepDown();
      }
      return false;
    }
  }

  /**
   * Start sending heartbeats to maintain leadership
   */
  private startHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    this.heartbeatInterval = setInterval(async () => {
      try {
        const success = await this.storage.updateHeartbeat(this.LOCK_ID, this.SERVER_ID);

        if (!success) {
          console.log('Lost leadership during heartbeat, stepping down');
          this.stepDown();
        }
      } catch (error) {
        console.error('Error updating heartbeat:', error);
        this.stepDown();
      }
    }, this.HEARTBEAT_INTERVAL);
  }

  /**
   * Start polling to try to acquire leadership
   */
  private startElectionPolling(): void {
    if (this.electionPollingInterval) {
      clearInterval(this.electionPollingInterval);
    }

    this.electionPollingInterval = setInterval(async () => {
      if (this.isRunning && !this.isLeader) {
        await this.tryAcquireLeadership();
      }
    }, this.ELECTION_POLLING_INTERVAL);
  }

  /**
   * Step down from leadership
   */
  private stepDown(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = undefined;
    }
    
    const wasLeader = this.isLeader;
    this.isLeader = false;
    
    if (wasLeader && this.onLoseLeadershipCallback) {
      this.onLoseLeadershipCallback();
    }
    
    // Ensure election polling is active
    if (!this.electionPollingInterval && this.isRunning) {
      this.startElectionPolling();
    }
  }

  /**
   * Gracefully shutdown the leader election process
   */
  async shutdown(): Promise<void> {
    this.isRunning = false;
    
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = undefined;
    }
    if (this.electionPollingInterval) {
      clearInterval(this.electionPollingInterval);
      this.electionPollingInterval = undefined;
    }

    if (this.isLeader) {
      try {
        await this.storage.releaseLock(this.LOCK_ID, this.SERVER_ID);
        this.isLeader = false;
      } catch (error) {
        console.error('Error releasing leadership lock:', error);
      }
    }
  }

  /**
   * Check if this instance is currently the leader
   */
  isCurrentLeader(): boolean {
    return this.isLeader;
  }
} 