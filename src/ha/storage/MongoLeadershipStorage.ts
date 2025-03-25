import { Collection, Db } from 'mongodb';
import { ILeadershipStorage } from '../ILeadershipStorage.js';

interface LockDocument {
  _id: string;
  leaderId: string;
  lastHeartbeat: Date;
}

interface MongoLeadershipStorageOptions {
  ttlSeconds: number;
  collectionName?: string;
}

/**
 * MongoDB implementation of the leadership storage
 * Provides atomic operations for leader election using MongoDB
 */
export class MongoLeadershipStorage implements ILeadershipStorage {
  private readonly COLLECTION_NAME: string;
  private readonly TTL_SECONDS: number;
  private lockCollection: Collection<LockDocument>;

  /**
   * Creates a new MongoLeadershipStorage
   * @param db MongoDB database instance
   * @param options Configuration options for the storage
   */
  constructor(
    db: Db,
    options: MongoLeadershipStorageOptions
  ) {
    this.COLLECTION_NAME = options.collectionName || 'leader_election';
    this.TTL_SECONDS = options.ttlSeconds;
    this.lockCollection = db.collection<LockDocument>(this.COLLECTION_NAME);
  }

  /**
   * Sets up a TTL index on lastHeartbeat to automatically expire locks
   * @param expirySeconds Seconds after which a lock without heartbeat will be deleted
   */
  async setupTTLIndex(expirySeconds: number): Promise<void> {
    await this.lockCollection.createIndex(
      { lastHeartbeat: 1 },
      { expireAfterSeconds: expirySeconds }
    );
  }

  /**
   * Try to acquire a leadership lock
   * @param lockId The identifier for the lock
   * @param serverId The unique ID of the server trying to acquire leadership
   * @returns true if leadership was acquired, false otherwise
   */
  async tryAcquireLock(lockId: string, serverId: string): Promise<boolean> {
    try {
      const now = new Date();
      const expiredTime = new Date(now.getTime() - this.TTL_SECONDS * 1000);
      
      const result = await this.lockCollection.findOneAndUpdate(
        {
          _id: lockId,
          $or: [
            { lastHeartbeat: { $lt: expiredTime } },
            { lastHeartbeat: { $exists: false } }
          ]
        },
        {
          $set: {
            _id: lockId,
            leaderId: serverId,
            lastHeartbeat: now
          }
        },
        { upsert: true }
      );

      // If we got a result, we acquired leadership
      return !!result;
    } catch (error) {
      console.error('Error acquiring lock:', error);
      return false;
    }
  }

  /**
   * Update the heartbeat timestamp to maintain leadership
   * @param lockId The identifier for the lock
   * @param serverId The unique ID of the server updating its heartbeat
   * @returns true if heartbeat was updated, false if leadership was lost
   */
  async updateHeartbeat(lockId: string, serverId: string): Promise<boolean> {
    try {
      const now = new Date();
      
      const result = await this.lockCollection.findOneAndUpdate(
        {
          _id: lockId,
          leaderId: serverId
        },
        {
          $set: {
            lastHeartbeat: now
          }
        },
        { upsert: true }
      );

      return !!result;
    } catch (error) {
      console.error('Error updating heartbeat:', error);
      return false;
    }
  }

  /**
   * Release a leadership lock
   * @param lockId The identifier for the lock
   * @param serverId The unique ID of the server releasing leadership
   */
  async releaseLock(lockId: string, serverId: string): Promise<void> {
    try {
      await this.lockCollection.deleteOne({
        _id: lockId,
        leaderId: serverId
      });
    } catch (error) {
      console.error('Error releasing lock:', error);
      throw error;
    }
  }
} 