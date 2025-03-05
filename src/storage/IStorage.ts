import { Record } from '../Record.js';

export interface IStorage {
  put(requestId: bigint, record: Record): Promise<boolean>;
  putAll(records: Map<bigint, Record>): Promise<boolean>;
  get(requestId: bigint): Promise<Record>;
}
