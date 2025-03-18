import { RequestId } from '@unicitylabs/commons/lib/api/RequestId.js';

import { AggregatorRecord } from './AggregatorRecord.js';

export interface IAggregatorRecordStorage {
  put(requestId: RequestId, record: AggregatorRecord): Promise<boolean>;
  get(requestId: RequestId): Promise<AggregatorRecord>;
}
