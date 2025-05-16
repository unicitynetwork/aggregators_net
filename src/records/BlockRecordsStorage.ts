import { RequestId } from '@unicitylabs/commons/lib/api/RequestId.js';
import { BigintConverter } from '@unicitylabs/commons/lib/util/BigintConverter.js';
import type { ChangeStreamDocument } from 'mongodb';
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

export class BlockRecordsStorage implements IBlockRecordsStorage {
  private changeListeners: BlockRecordsChangeListener[] = [];
  private changeStream: mongoose.mongo.ChangeStream | null = null;

  public async put(blockRecords: BlockRecords, session?: mongoose.ClientSession): Promise<boolean> {
    try {
      const recordsDoc = new BlockRecordsModel({
        blockNumber: blockRecords.blockNumber,
        requestIds: blockRecords.requestIds.map((requestId) => requestId.toDto()),
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
      stored.requestIds.map((requestId) => RequestId.fromDto(requestId.toString())),
    );
  }

  public async getLatest(): Promise<BlockRecords | null> {
    const stored = await BlockRecordsModel.findOne().sort({ blockNumber: -1 });
    if (!stored) {
      return null;
    }
    return new BlockRecords(
      stored.blockNumber,
      stored.requestIds.map((requestId) => RequestId.fromDto(requestId.toString())),
    );
  }

  /**
   * Adds a listener for change events when new block records are added
   * @param listener The callback function to be called when changes occur
   */
  public addChangeListener(listener: BlockRecordsChangeListener): void {
    // Start watching for changes if this is the first listener
    if (this.changeListeners.length === 0) {
      this.startWatchingChanges();
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
   * Stops watching for changes in the BlockRecords collection
   */
  public async stopWatchingChanges(): Promise<void> {
    if (this.changeStream) {
      try {
        await this.changeStream.close();
        this.changeStream = null;
        logger.info('Stopped watching for changes in BlockRecords collection');
      } catch (error) {
        logger.error('Error closing BlockRecords change stream:', error);
        throw error;
      }
    }
  }

  /**
   * Starts watching for changes in the BlockRecords collection
   */
  private startWatchingChanges(): void {
    if (this.changeStream) {
      logger.debug('Change stream already running for BlockRecords collection');
      return;
    }

    try {
      // Set up the change stream to watch for insert operations
      this.changeStream = BlockRecordsModel.watch([{ $match: { operationType: 'insert' } }], {
        fullDocument: 'updateLookup',
      });

      this.changeStream.on('change', (change: ChangeStreamDocument<IBlockRecords>) => {
        try {
          if (change.operationType === 'insert' && change.fullDocument) {
            const { blockNumber, requestIds } = change.fullDocument;

            // Mongoose does not automatically convert the blockNumber to a bigint when using the change stream, so we need to do it manually
            const binary = blockNumber as any;
            const uint8Array = new Uint8Array(binary.buffer);
            const blockNumberBigInt = BigintConverter.decode(uint8Array);

            const blockRecords = new BlockRecords(
              blockNumberBigInt,
              requestIds.map((requestId: string) => RequestId.fromDto(requestId)),
            );

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
      });

      this.changeStream.on('error', (error: Error) => {
        logger.error('BlockRecords change stream error:', error);
        this.stopWatchingChanges().catch((closeError: unknown) => {
          logger.error('Error stopping change stream after error:', closeError);
        });
      });

      logger.info('Started watching for changes in BlockRecords collection');
    } catch (error: unknown) {
      logger.error('Failed to start watching BlockRecords collection:', error);
      throw error;
    }
  }
}
