import { AggregatorRecord } from './AggregatorRecord.js';

export interface IAggregatorRecordStorage {
  put(requestId: bigint, record: AggregatorRecord): Promise<boolean>;
  get(requestId: bigint): Promise<AggregatorRecord>;
}
