import mongoose, { model } from 'mongoose';

import { ILeadershipStorage } from './ILeadershipStorage.js';

interface ILockDocument {
  lockId: string;
  leaderId: string;
  lastHeartbeat: Date;
}

const LockSchema = new mongoose.Schema({
  lockId: { required: true, type: String },
  leaderId: { required: true, type: String },
  lastHeartbeat: { required: true, type: Date },
});

const LockModel = model<ILockDocument>('Lock', LockSchema);

/**
 * MongoDB implementation of the leadership storage.
 * Provides atomic operations for leader election using MongoDB.
 */
export class LeadershipStorage implements ILeadershipStorage {
  /**
   * Creates a new LeadershipStorage.
   * @param ttlSeconds How long a lock can be held without heartbeat.
   */
  public constructor(public readonly ttlSeconds: number) {
    LockSchema.path('lastHeartbeat').index({ expireAfterSeconds: ttlSeconds });
  }

  /**
   * Try to acquire a leadership lock.
   * @param lockId The identifier for the lock.
   * @param serverId The unique ID of the server trying to acquire leadership.
   * @returns true if leadership was acquired, false otherwise.
   */
  public async tryAcquireLock(lockId: string, serverId: string): Promise<boolean> {
    try {
      const now = new Date();
      const expiredTime = new Date(now.getTime() - this.ttlSeconds * 1000);

      const validLock = await LockModel.findOne({
        lockId: lockId,
        lastHeartbeat: { $gte: expiredTime },
      });

      if (validLock) {
        return false;
      }

      // either update an expired lock or insert a new one if none exists
      const updateResult = await LockModel.updateOne(
        {
          lockId: lockId,
          lastHeartbeat: { $lt: expiredTime },
        },
        {
          $set: {
            leaderId: serverId,
            lastHeartbeat: now,
          },
        },
        { upsert: true },
      );

      return updateResult.modifiedCount > 0 || updateResult.upsertedCount > 0;
    } catch (error) {
      console.error('Error acquiring lock:', error);
      return false;
    }
  }

  /**
   * Update the heartbeat timestamp to maintain leadership.
   * @param lockId The identifier for the lock.
   * @param serverId The unique ID of the server updating its heartbeat.
   * @returns true if heartbeat was updated, false if leadership was lost.
   */
  public async updateHeartbeat(lockId: string, serverId: string): Promise<boolean> {
    try {
      const now = new Date();

      const result = await LockModel.findOneAndUpdate(
        {
          lockId: lockId,
          leaderId: serverId,
        },
        {
          $set: {
            lastHeartbeat: now,
          },
        },
        { upsert: true },
      );

      return !!result;
    } catch (error) {
      console.error('Error updating heartbeat:', error);
      return false;
    }
  }

  /**
   * Release a leadership lock.
   * @param lockId The identifier for the lock.
   * @param serverId The unique ID of the server releasing leadership.
   */
  public async releaseLock(lockId: string, serverId: string): Promise<void> {
    try {
      await LockModel.deleteOne({
        lockId: lockId,
        leaderId: serverId,
      });
    } catch (error) {
      console.error('Error releasing lock:', error);
      throw error;
    }
  }
}
