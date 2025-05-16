import mongoose from 'mongoose';

import { BlockRecords } from './BlockRecords.js';

export interface BlockRecordsChangeListener {
  (blockRecords: BlockRecords): void;
}

export interface IBlockRecordsStorage {
  put(blockRecords: BlockRecords, session?: mongoose.ClientSession): Promise<boolean>;
  get(blockNumber: bigint): Promise<BlockRecords | null>;
  getLatest(): Promise<BlockRecords | null>;

  addChangeListener(listener: BlockRecordsChangeListener): void;
  removeChangeListener(listener: BlockRecordsChangeListener): void;
  stopWatchingChanges(): Promise<void>;
}
