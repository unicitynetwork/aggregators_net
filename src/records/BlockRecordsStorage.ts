import { RequestId } from '@unicitylabs/commons/lib/api/RequestId.js';
import mongoose, { model } from 'mongoose';

import { SCHEMA_TYPES } from '../StorageSchemaTypes.js';
import { BlockRecords } from './BlockRecords.js';
import { IBlockRecordsStorage } from './IBlockRecordsStorage.js';
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
  public async put(blockRecords: BlockRecords): Promise<boolean> {
    try {
      await new BlockRecordsModel({
        blockNumber: blockRecords.blockNumber,
        requestIds: blockRecords.requestIds.map((requestId) => requestId.toDto()),
      }).save();
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
    const stored = await BlockRecordsModel.findOne().sort({ blockNumber: 1 });
    if (!stored) {
      return null;
    }
    return new BlockRecords(
      stored.blockNumber,
      stored.requestIds.map((requestId) => RequestId.fromDto(requestId.toString())),
    );
  }
}
