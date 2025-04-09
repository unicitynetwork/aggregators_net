import { v4 as uuidv4 } from 'uuid';

import { ILeadershipStorage } from './ILeadershipStorage.js';

interface ILeaderElectionOptions {
  heartbeatInterval: number; // How often to send heartbeats
  electionPollingInterval: number; // How often to try to acquire leadership
  lockTtlSeconds: number; // How long a lock can be held without heartbeat
  lockId?: string; // Optional custom lock ID
  onBecomeLeader?: () => void; // Optional callback when becoming leader
  onLoseLeadership?: () => void; // Optional callback when losing leadership
  serverId?: string; // Optional custom server ID for logging
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
  private readonly SERVER_ID: string;

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
  public constructor(
    private readonly storage: ILeadershipStorage,
    options: ILeaderElectionOptions,
  ) {
    this.LOCK_ID = options.lockId ?? 'leader_lock';
    this.HEARTBEAT_INTERVAL = options.heartbeatInterval;
    this.ELECTION_POLLING_INTERVAL = options.electionPollingInterval;
    this.SERVER_ID = options.serverId ?? uuidv4();

    this.onBecomeLeaderCallback = options.onBecomeLeader;
    this.onLoseLeadershipCallback = options.onLoseLeadership;
  }

  /**
   * Start the leader election process.
   */
  public async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    // First attempt to acquire leadership
    const initialLeadershipAcquired = await this.tryAcquireLeadership();

    if (!initialLeadershipAcquired) {
      console.log(`Server ${this.SERVER_ID} failed to acquire leadership lock, running in standby mode`);
    }

    // Start polling for leadership
    this.startElectionPolling();
  }

  /**
   * Gracefully shutdown the leader election process.
   */
  public async shutdown(): Promise<void> {
    // First set running to false to prevent any new timer callbacks
    this.isRunning = false;

    // Immediately clear any existing timers
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
      } catch (error) {
        console.error('Error releasing leadership lock:', error);
      } finally {
        this.isLeader = false;
      }
    }

    console.log('Leader election process shutdown completed.');
  }

  /**
   * Check if this instance is currently the leader.
   */
  public isCurrentLeader(): boolean {
    return this.isLeader;
  }

  /**
   * Try to acquire leadership.
   */
  private async tryAcquireLeadership(): Promise<boolean> {
    try {
      const acquired = await this.storage.tryAcquireLock(this.LOCK_ID, this.SERVER_ID);

      if (acquired) {
        if (!this.isLeader) {
          this.isLeader = true;
          this.startHeartbeat();

          if (this.onBecomeLeaderCallback) {
            this.onBecomeLeaderCallback();
          }
        }
        return true;
      } else if (this.isLeader) {
        // We thought we were leader but we're not
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
   * Start sending heartbeats to maintain leadership.
   */
  private startHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    this.heartbeatInterval = setInterval(async () => {
      try {
        const success = await this.storage.updateHeartbeat(this.LOCK_ID, this.SERVER_ID);

        if (!success) {
          console.log('Lost leadership during heartbeat, stepping down.');
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
   * Step down from leadership.
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
}
