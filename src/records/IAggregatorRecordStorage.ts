import { RequestId } from '@unicitylabs/commons/lib/api/RequestId.js';

import { AggregatorRecord } from './AggregatorRecord.js';

export interface IAggregatorRecordStorage {
  put(record: AggregatorRecord): Promise<boolean>;
  putBatch(records: AggregatorRecord[]): Promise<boolean>;
  get(requestId: RequestId): Promise<AggregatorRecord | null>;
}
