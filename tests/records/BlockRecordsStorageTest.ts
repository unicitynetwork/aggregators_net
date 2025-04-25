import assert from 'assert';

import { RequestId } from '@unicitylabs/commons/lib/api/RequestId.js';
import { DataHasher } from '@unicitylabs/commons/lib/hash/DataHasher.js';
import { HashAlgorithm } from '@unicitylabs/commons/lib/hash/HashAlgorithm.js';
import { SigningService } from '@unicitylabs/commons/lib/signing/SigningService.js';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

import logger from '../../src/logger.js';
import { BlockRecords } from '../../src/records/BlockRecords.js';
import { BlockRecordsStorage } from '../../src/records/BlockRecordsStorage.js';

describe('Block Records Storage Tests', () => {
  jest.setTimeout(60000);

  let mongoServer: MongoMemoryServer;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    const mongoUri = mongoServer.getUri();
    logger.info(`Connecting to in-memory MongoDB at ${mongoUri}`);
    await mongoose.connect(mongoUri);
  });

  afterAll(async () => {
    if (mongoose.connection.readyState !== 0) {
      logger.info('Closing mongoose connection...');
      await mongoose.connection.close();
    }
    if (mongoServer) {
      await mongoServer.stop();
    }
  });

  it('Store and retrieve block records', async () => {
    const storage = new BlockRecordsStorage();
    const signingService = await SigningService.createFromSecret(SigningService.generatePrivateKey());
    const stateHash = await new DataHasher(HashAlgorithm.SHA256).update(new Uint8Array([1, 2, 3])).digest();
    const requestId = await RequestId.create(signingService.publicKey, stateHash);

    const blockNumber = 1n;
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
      expect((error as Error).message).toContain('duplicate key error');
    }
  });

  it('Should get the latest block correctly', async () => {
    await mongoose.connection.collection('blockrecords').deleteMany({});
    logger.info('Cleared existing block records');

    const storage = new BlockRecordsStorage();
    const signingService = await SigningService.createFromSecret(SigningService.generatePrivateKey());

    // Create multiple blocks with different block numbers
    const blockNumbers = [1n, 5n, 10n, 3n, 7n];
    const highestBlockNumber = 10n;

    logger.info('Creating test blocks with numbers:', blockNumbers);

    const createTestRequestId = async () => {
      const stateHash = await new DataHasher(HashAlgorithm.SHA256)
        .update(new Uint8Array([Math.random() * 255, Math.random() * 255, Math.random() * 255]))
        .digest();
      return await RequestId.create(signingService.publicKey, stateHash);
    };

    // Store blocks in random order
    for (const blockNumber of blockNumbers) {
      const requestId = await createTestRequestId();
      const blockRecords = new BlockRecords(blockNumber, [requestId]);
      await storage.put(blockRecords);
      logger.info(`Stored block ${blockNumber}`);
    }

    const latestBlock = await storage.getLatest();
    expect(latestBlock).not.toBeNull();
    assert(latestBlock);

    expect(latestBlock.blockNumber).toEqual(highestBlockNumber);

    // Verify all blocks exist
    for (const blockNumber of blockNumbers) {
      const block = await storage.get(blockNumber);
      expect(block).not.toBeNull();
      assert(block);
      expect(block.blockNumber).toEqual(blockNumber);
    }
  });
});
