import mongoose from 'mongoose';

import { Block } from './Block.js';

export interface IBlockStorage {
  put(block: Block, session?: mongoose.ClientSession): Promise<boolean>;
  get(index: bigint): Promise<Block | null>;
  getNextBlockNumber(): Promise<bigint>;
}
