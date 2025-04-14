import { BlockRecords } from './BlockRecords.js';

export interface IBlockRecordsStorage {
  put(blockRecords: BlockRecords): Promise<boolean>;
  get(blockNumber: bigint): Promise<BlockRecords | null>;
  getLatest(): Promise<BlockRecords | null>;
}
