import { RequestId } from '@unicitylabs/commons/lib/api/RequestId.js';

import { Block } from './Block.js';

export interface IBlockStorage {
  put(requestId: RequestId, block: Block): Promise<boolean>;
  get(requestId: RequestId): Promise<Block | null>;
  getNextBlockNumber(): Promise<bigint>;
}
