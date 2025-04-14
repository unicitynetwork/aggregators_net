import assert from 'assert';

import { RequestId } from '@unicitylabs/commons/lib/api/RequestId.js';
import { DataHasher } from '@unicitylabs/commons/lib/hash/DataHasher.js';
import { HashAlgorithm } from '@unicitylabs/commons/lib/hash/HashAlgorithm.js';
import { SigningService } from '@unicitylabs/commons/lib/signing/SigningService.js';
import { StartedTestContainer } from 'testcontainers';

import { BlockStorage } from '../../src/hashchain/BlockStorage.js';
import { BlockRecordsStorage } from '../../src/records/BlockRecordsStorage.js';
import { startMongoDb, stopMongoDb } from '../TestContainers.js';

describe('Block Records Storage Tests', () => {
  jest.setTimeout(60000);

  let container: StartedTestContainer;

  beforeAll(async () => {
    container = await startMongoDb();
  });

  afterAll(() => {
    stopMongoDb(container);
  });

  it('Store and retrieve block records', async () => {
    const blockStorage = new BlockStorage();
    const storage = new BlockRecordsStorage();
    const signingService = await SigningService.createFromSecret(SigningService.generatePrivateKey());
    const stateHash = await new DataHasher(HashAlgorithm.SHA256).update(new Uint8Array([1, 2, 3])).digest();
    const requestId = await RequestId.create(signingService.publicKey, stateHash);

    const blockNumber = await blockStorage.getNextBlockNumber();
    const stored = await storage.put({
      blockNumber: blockNumber,
      requestIds: [requestId],
    });
    expect(stored).toBeTruthy();

    const retrieved = await storage.get(blockNumber);
    expect(retrieved).not.toBeNull();
    assert(retrieved);
    expect(retrieved.blockNumber).toEqual(blockNumber);
    expect(retrieved.requestIds.length).toEqual(1);
    expect(retrieved.requestIds[0].hash.equals(requestId.hash)).toBeTruthy();

    try {
      await storage.put({
        blockNumber: blockNumber,
        requestIds: [requestId],
      });
    } catch (error) {
      expect((error as Error).message).toEqual(
        'E11000 duplicate key error collection: test.blockrecords index: blockNumber_1 dup key: { blockNumber: BinData(0, 01) }',
      );
    }
  });
});
