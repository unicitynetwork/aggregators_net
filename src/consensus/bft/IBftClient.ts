import { DataHash } from '@unicitylabs/commons/lib/hash/DataHash.js';

import { SubmitHashResponse } from './SubmitHashResponse.js';

export interface IBftClient {
  submitHash(transactionHash: DataHash): Promise<SubmitHashResponse>;
}
