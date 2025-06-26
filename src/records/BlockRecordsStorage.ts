import { RequestId } from '@unicitylabs/commons/lib/api/RequestId.js';
import { BigintConverter } from '@unicitylabs/commons/lib/util/BigintConverter.js';
import type { ChangeStreamDocument, Binary, ResumeToken } from 'mongodb';
import mongoose, { model } from 'mongoose';

import { SCHEMA_TYPES } from '../StorageSchemaTypes.js';
import { BlockRecords } from './BlockRecords.js';
import { BlockRecordsChangeListener, IBlockRecordsStorage } from './IBlockRecordsStorage.js';
import logger from '../logger.js';

interface IBlockRecords {
  blockNumber: bigint;
  requestIds: string[];
}

const BlockRecordsSchema = new mongoose.Schema({
  blockNumber: { required: true, type: SCHEMA_TYPES.BIGINT_BINARY, unique: true },
  requestIds: { required: true, type: [String] },
});

const BlockRecordsModel = model<IBlockRecords>('BlockRecords', BlockRecordsSchema);

interface IBlockRecordsResumeToken {
  _id: string;
  token: ResumeToken;
}

const ResumeTokenSchema = new mongoose.Schema<IBlockRecordsResumeToken>({
  _id: { type: String, required: true },
  token: { type: mongoose.Schema.Types.Mixed, required: true },
});

const ResumeTokenModel = model<IBlockRecordsResumeToken>('BlockRecordsResumeToken', ResumeTokenSchema);

export class BlockRecordsStorage implements IBlockRecordsStorage {
  private changeListeners: BlockRecordsChangeListener[] = [];
  private changeStream: mongoose.mongo.ChangeStream | null = null;
  private resumeTokenId: string;
  private startAtOperationTime: ResumeToken | undefined;

  private constructor(resumeTokenId: string) {
    this.resumeTokenId = resumeTokenId;
  }

  public static async create(serverId: string): Promise<BlockRecordsStorage> {
    const resumeTokenId = `blockRecords_${serverId}`;
    const storage = new BlockRecordsStorage(resumeTokenId);
    
    await storage.captureCurrentClusterTime();
    
    return storage;
  }



  /**
   * Captures the current cluster time and sets it as startAtOperationTime.
   * This ensures followers receive events that occur during SMT loading.
   */
  public async captureCurrentClusterTime(): Promise<void> {
    const clusterTime = await this.getCurrentClusterTime();
    if (clusterTime) {
      this.startAtOperationTime = clusterTime;
    } else {
      logger.warn('Failed to capture cluster time for BlockRecords change stream. Listeners may miss events.');
    }
  }

  /**
   * Gets the current cluster time from MongoDB
   */
  private async getCurrentClusterTime(): Promise<ResumeToken | null> {
    try {
      const pingRes = await (mongoose.connection.db as any).command({ ping: 1 });
      return pingRes?.$clusterTime?.clusterTime || null;
    } catch (error) {
      logger.error('Failed to obtain current clusterTime:', error);
      return null;
    }
  }

  /**
   * Persists the resume token for later resumption
   */
  private async persistResumeToken(token: ResumeToken): Promise<void> {
    try {
      await ResumeTokenModel.findOneAndUpdate(
        { _id: this.resumeTokenId },
        { token },
        { upsert: true, new: true }
      );
    } catch (error) {
      logger.error('Failed to persist resume token for BlockRecords change stream:', error);
    }
  }

  /**
   * Removes the stored resume token (used when token becomes invalid)
   */
  private async clearResumeToken(): Promise<void> {
    try {
      await ResumeTokenModel.deleteOne({ _id: this.resumeTokenId });
    } catch (error) {
      logger.error('Failed to delete stale resume token:', error);
    }
  }

  /**
   * Processes a change stream document and notifies listeners
   */
  private async processChangeEvent(change: ChangeStreamDocument<IBlockRecords>): Promise<void> {
    try {
      // Persist resume token for every change so we can resume later if needed
      if (change._id) {
        await this.persistResumeToken(change._id);
      }

      if (change.operationType === 'insert' && change.fullDocument) {
        const { blockNumber, requestIds } = change.fullDocument;

        // Mongoose does not automatically convert the blockNumber to a bigint when using the change stream, so we need to do it manually
        let blockRecords: BlockRecords;
        try {
          const binary = blockNumber as unknown as Binary;
          const uint8Array = new Uint8Array(binary.buffer);
          const blockNumberBigInt = BigintConverter.decode(uint8Array);

          blockRecords = new BlockRecords(
            blockNumberBigInt,
            requestIds.map((requestId: string) => RequestId.fromJSON(requestId)),
          );
        } catch (error) {
          logger.error('Failed to decode blockNumber from MongoDB Binary:', error);
          return;
        }

        for (const listener of this.changeListeners) {
          try {
            listener(blockRecords);
          } catch (listenerError) {
            logger.error('Error in block records change listener:', listenerError);
          }
        }
      }
    } catch (error: unknown) {
      logger.error('Error processing BlockRecords change event:', error);
    }
  }

  /**
   * Handles change stream errors and attempts recovery
   */
  private async handleStreamError(error: Error & { code?: number; codeName?: string }): Promise<void> {
    logger.error('BlockRecords change stream error:', error);

    const isHistoryLost = error.code === 286 || error.codeName === 'ChangeStreamHistoryLost';

    try {
      await this.stopWatchingChanges();

      if (isHistoryLost) {
        await this.handleHistoryLostError();
      }

      // Small delay to avoid busy-looping
      await new Promise((resolve) => setTimeout(resolve, 1000));

      await this.startWatchingChanges();
    } catch (restartError) {
      logger.error('Failed to restart BlockRecords change stream after error:', restartError);
    }
  }

  /**
   * Handles the specific case where oplog history is lost
   */
  private async handleHistoryLostError(): Promise<void> {
    // The resume token is no longer valid. Remove it and restart from current cluster time.
    await this.clearResumeToken();

    const clusterTime = await this.getCurrentClusterTime();
    if (clusterTime) {
      this.startAtOperationTime = clusterTime;
      logger.warn('Oplog history lost. Restarting change stream from current cluster time. ' +
        'A full SMT rebuild may be required to guarantee consistency.');
    }
  }

  /**
   * Creates the watch options for the change stream
   */
  private async createWatchOptions(): Promise<Record<string, unknown>> {
    const watchOptions: Record<string, unknown> = {
      fullDocument: 'updateLookup',
    };

    const resumeDoc = await ResumeTokenModel.findById(this.resumeTokenId).lean();

    if (resumeDoc?.token) {
      watchOptions.resumeAfter = resumeDoc.token;
      logger.info('Resuming BlockRecords change stream using stored resume token');
    } else if (this.startAtOperationTime) {
      watchOptions.startAtOperationTime = this.startAtOperationTime as any; // driver expects BSON Timestamp
      logger.info('Starting BlockRecords change stream at captured clusterTime');
    }

    return watchOptions;
  }

  public async put(blockRecords: BlockRecords, session?: mongoose.ClientSession): Promise<boolean> {
    try {
      const recordsDoc = new BlockRecordsModel({
        blockNumber: blockRecords.blockNumber,
        requestIds: blockRecords.requestIds.map((requestId) => requestId.toJSON()),
      });

      await recordsDoc.save({ session });
    } catch (error) {
      logger.error('Failed to add block records: ', error);
      throw error;
    }
    return true;
  }

  public async get(blockNumber: bigint): Promise<BlockRecords | null> {
    const stored = await BlockRecordsModel.findOne({ blockNumber: blockNumber });
    if (!stored) {
      return null;
    }
    return new BlockRecords(
      blockNumber,
      stored.requestIds.map((requestId) => RequestId.fromJSON(requestId.toString())),
    );
  }

  public async getLatest(): Promise<BlockRecords | null> {
    const stored = await BlockRecordsModel.findOne().sort({ blockNumber: -1 });
    if (!stored) {
      return null;
    }
    return new BlockRecords(
      stored.blockNumber,
      stored.requestIds.map((requestId) => RequestId.fromJSON(requestId.toString())),
    );
  }

  /**
   * Adds a listener for change events when new block records are added
   * @param listener The callback function to be called when changes occur
   */
  public addChangeListener(listener: BlockRecordsChangeListener): void {
    // Start watching for changes if this is the first listener
    if (this.changeListeners.length === 0) {
      this.startWatchingChanges().catch((error) => {
        logger.error('Failed to start watching BlockRecords changes:', error);
      });
    }

    this.changeListeners.push(listener);
    logger.debug(`Added block records change listener. Total listeners: ${this.changeListeners.length}`);
  }

  /**
   * Removes a previously registered change listener
   * @param listener The listener to remove
   */
  public removeChangeListener(listener: BlockRecordsChangeListener): void {
    const index = this.changeListeners.indexOf(listener);
    if (index !== -1) {
      this.changeListeners.splice(index, 1);
      logger.debug(`Removed block records change listener. Remaining listeners: ${this.changeListeners.length}`);

      // Stop watching for changes if no more listeners remain
      if (this.changeListeners.length === 0) {
        this.stopWatchingChanges().catch((error: unknown) => {
          logger.error('Error stopping change stream after last listener removed:', error);
        });
      }
    }
  }

  /**
   * Cleans up resources by stopping the change stream
   */
  public async cleanup(): Promise<void> {
    return this.stopWatchingChanges();
  }

  /**
   * Stops watching for changes in the BlockRecords collection
   */
  private async stopWatchingChanges(): Promise<void> {
    if (this.changeStream) {
      try {
        await this.changeStream.close();
        logger.info('Stopped watching for changes in BlockRecords collection');
      } catch (error) {
        logger.error('Error closing BlockRecords change stream:', error);
        throw error;
      } finally {
        this.changeStream = null;
      }
    }
  }

  /**
   * Starts watching for changes in the BlockRecords collection
   */
  private async startWatchingChanges(): Promise<void> {
    if (this.changeStream) {
      logger.debug('Change stream already running for BlockRecords collection');
      return;
    }

    try {
      const watchOptions = await this.createWatchOptions();

      // Set up the change stream to watch for insert operations
      this.changeStream = BlockRecordsModel.watch([{ $match: { operationType: 'insert' } }], watchOptions);

      this.changeStream.on('change', async (change: ChangeStreamDocument<IBlockRecords>) => {
        try {
          await this.processChangeEvent(change);
        } catch (error: unknown) {
          logger.error('Error processing BlockRecords change event:', error);
        }
      });

      this.changeStream.on('error', (error: Error & { code?: number; codeName?: string }) => {
        this.handleStreamError(error);
      });

      logger.info('Started watching for changes in BlockRecords collection');
    } catch (error: unknown) {
      logger.error('Failed to start watching BlockRecords collection:', error);
      throw error;
    }
  }
}
