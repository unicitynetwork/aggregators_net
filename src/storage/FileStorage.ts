import { writeFileSync } from 'node:fs';

import { Record } from '../Record.js';
import { IStorage } from './IStorage.js';

export class FileStorage implements IStorage {
  public constructor(public readonly filePath: string) {}

  public put(requestId: bigint, record: Record): Promise<boolean> {
    throw new Error('Method not implemented.');
  }

  public putAll(records: Map<bigint, Record>): Promise<boolean> {
    writeFileSync(this.filePath, JSON.stringify(records));
    return Promise.resolve(true);
  }

  public get(requestId: bigint): Promise<Record> {
    throw new Error('Method not implemented.');
  }
}
