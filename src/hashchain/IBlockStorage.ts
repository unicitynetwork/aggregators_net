import { Block } from './Block.js';

export interface IBlockStorage {
  put(block: Block): Promise<boolean>;
  get(index: bigint): Promise<Block | null>;
  getNextBlockNumber(): Promise<bigint>;
}
