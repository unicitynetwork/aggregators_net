import assert from 'assert';

import { Authenticator } from '@unicitylabs/commons/lib/api/Authenticator.js';
import { RequestId } from '@unicitylabs/commons/lib/api/RequestId.js';
import { DataHasher } from '@unicitylabs/commons/lib/hash/DataHasher.js';
import { HashAlgorithm } from '@unicitylabs/commons/lib/hash/HashAlgorithm.js';
import { SigningService } from '@unicitylabs/commons/lib/signing/SigningService.js';
import { HexConverter } from '@unicitylabs/commons/lib/util/HexConverter.js';
import { StartedTestContainer } from 'testcontainers';

import { AggregatorRecord } from '../../src/records/AggregatorRecord.js';
import { AggregatorRecordStorage } from '../../src/records/AggregatorRecordStorage.js';
import { startMongoDb, stopMongoDb } from '../TestContainers.js';

describe('Aggregator Record Storage Tests', () => {
  jest.setTimeout(60000);

  let container: StartedTestContainer;

  beforeAll(async () => {
    container = await startMongoDb();
  });

  afterAll(() => {
    stopMongoDb(container);
  });

  it('Store and retrieve record', async () => {
    const storage = new AggregatorRecordStorage();
    const signingService = await SigningService.createFromSecret(SigningService.generatePrivateKey());
    const stateHash = await new DataHasher(HashAlgorithm.SHA256).update(new Uint8Array([1, 2, 3])).digest();
    const transactionHash = await new DataHasher(HashAlgorithm.SHA256).update(new Uint8Array([4, 5, 6])).digest();
    const requestId = await RequestId.create(signingService.publicKey, stateHash);
    const authenticator = await Authenticator.create(signingService, transactionHash, stateHash);
    const aggregatorRecord = new AggregatorRecord(requestId, transactionHash, authenticator);

    console.log('Storing record...');
    const stored = await storage.put(aggregatorRecord);
    console.log('Store result:', stored);

    console.log('Retrieving record...');
    const retrieved = await storage.get(requestId);
    expect(retrieved).not.toBeNull();
    assert(retrieved);
    console.log('Retrieved successfully');
    console.log('Data comparison:');
    expect(retrieved.requestId.toBigInt()).toEqual(aggregatorRecord.requestId.toBigInt());
    expect(retrieved.transactionHash.equals(aggregatorRecord.transactionHash)).toBeTruthy();
    expect(HexConverter.encode(retrieved.authenticator.signature.bytes)).toEqual(
      HexConverter.encode(aggregatorRecord.authenticator.signature.bytes),
    );
    expect(HexConverter.encode(retrieved.authenticator.publicKey)).toEqual(
      HexConverter.encode(aggregatorRecord.authenticator.publicKey),
    );
    expect(retrieved.authenticator.stateHash.equals(aggregatorRecord.authenticator.stateHash)).toBeTruthy();
    expect(retrieved.authenticator.algorithm).toEqual(aggregatorRecord.authenticator.algorithm);
  });

  it('Store and retrieve multiple records in batch', async () => {
    const storage = new AggregatorRecordStorage();
    const signingService = await SigningService.createFromSecret(SigningService.generatePrivateKey());
    const records: AggregatorRecord[] = [];
    const requestIds: RequestId[] = [];

    for (let i = 0; i < 5; i++) {
      const stateHash = await new DataHasher(HashAlgorithm.SHA256).update(new Uint8Array([1, 2, 3, i])).digest();
      const transactionHash = await new DataHasher(HashAlgorithm.SHA256).update(new Uint8Array([4, 5, 6, i])).digest();
      const requestId = await RequestId.create(signingService.publicKey, stateHash);
      const authenticator = await Authenticator.create(signingService, transactionHash, stateHash);
      const record = new AggregatorRecord(requestId, transactionHash, authenticator);
      records.push(record);
      requestIds.push(requestId);
    }

    console.log('Storing records in batch...');
    const stored = await storage.putBatch(records);
    console.log('Batch store result:', stored);
    expect(stored).toBeTruthy();

    for (let i = 0; i < records.length; i++) {
      console.log(`Retrieving record ${i + 1}...`);
      const retrieved = await storage.get(requestIds[i]);
      expect(retrieved).not.toBeNull();
      assert(retrieved);

      const originalRecord = records[i];
      expect(retrieved.requestId.toBigInt()).toEqual(originalRecord.requestId.toBigInt());
      expect(retrieved.transactionHash.equals(originalRecord.transactionHash)).toBeTruthy();
      expect(HexConverter.encode(retrieved.authenticator.signature.bytes)).toEqual(
        HexConverter.encode(originalRecord.authenticator.signature.bytes),
      );
      expect(HexConverter.encode(retrieved.authenticator.publicKey)).toEqual(
        HexConverter.encode(originalRecord.authenticator.publicKey),
      );
      expect(retrieved.authenticator.stateHash.equals(originalRecord.authenticator.stateHash)).toBeTruthy();
      expect(retrieved.authenticator.algorithm).toEqual(originalRecord.authenticator.algorithm);
    }
  });
});
