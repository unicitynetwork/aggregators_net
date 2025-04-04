import { DataHash } from '@unicitylabs/commons/lib/hash/DataHash.js';

import { SubmitHashResponse } from './SubmitHashResponse.js';

export interface IAlphabillClient {
  submitHash(transactionHash: DataHash): Promise<SubmitHashResponse>;
}
