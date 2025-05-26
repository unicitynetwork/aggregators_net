import assert from 'assert';

import { Authenticator } from '@unicitylabs/commons/lib/api/Authenticator.js';
import { RequestId } from '@unicitylabs/commons/lib/api/RequestId.js';
import { DataHasher } from '@unicitylabs/commons/lib/hash/DataHasher.js';
import { HashAlgorithm } from '@unicitylabs/commons/lib/hash/HashAlgorithm.js';
import { Signature } from '@unicitylabs/commons/lib/signing/Signature.js';
import { SigningService } from '@unicitylabs/commons/lib/signing/SigningService.js';
import { BigintConverter } from '@unicitylabs/commons/lib/util/BigintConverter.js';
import { HexConverter } from '@unicitylabs/commons/lib/util/HexConverter.js';
import { Binary } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

import logger from '../../src/logger.js';
import { AggregatorRecord } from '../../src/records/AggregatorRecord.js';
import { AggregatorRecordStorage } from '../../src/records/AggregatorRecordStorage.js';

describe('Aggregator Record Storage Tests', () => {
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

  it('Store and retrieve record', async () => {
    const storage = new AggregatorRecordStorage();
    const signingService = await SigningService.createFromSecret(SigningService.generatePrivateKey());
    const stateHash = await new DataHasher(HashAlgorithm.SHA256).update(new Uint8Array([1, 2, 3])).digest();
    const transactionHash = await new DataHasher(HashAlgorithm.SHA256).update(new Uint8Array([4, 5, 6])).digest();
    const requestId = await RequestId.create(signingService.publicKey, stateHash);
    const authenticator = await Authenticator.create(signingService, transactionHash, stateHash);
    const aggregatorRecord = new AggregatorRecord(requestId, transactionHash, authenticator);

    logger.info('Storing record...');
    const stored = await storage.put(aggregatorRecord);
    logger.info('Store result:', stored);

    logger.info('Retrieving record...');
    const retrieved = await storage.get(requestId);
    expect(retrieved).not.toBeNull();
    assert(retrieved);
    logger.info('Retrieved successfully');
    logger.info('Data comparison:');
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

    logger.info('Storing records in batch...');
    const stored = await storage.putBatch(records);
    logger.info('Batch store result:', stored);
    expect(stored).toBeTruthy();

    for (let i = 0; i < records.length; i++) {
      logger.info(`Retrieving record ${i + 1}...`);
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

  it('Try to store same batch of records twice', async () => {
    // Clear the collection first using mongoose directly
    await mongoose.connection.collection('aggregatorrecords').deleteMany({});

    const storage = new AggregatorRecordStorage();
    const signingService = await SigningService.createFromSecret(SigningService.generatePrivateKey());
    const records: AggregatorRecord[] = [];

    // Create 3 records
    for (let i = 0; i < 3; i++) {
      const stateHash = await new DataHasher(HashAlgorithm.SHA256).update(new Uint8Array([10, 20, 30, i])).digest();
      const transactionHash = await new DataHasher(HashAlgorithm.SHA256)
        .update(new Uint8Array([40, 50, 60, i]))
        .digest();
      const requestId = await RequestId.create(signingService.publicKey, stateHash);
      const authenticator = await Authenticator.create(signingService, transactionHash, stateHash);
      const record = new AggregatorRecord(requestId, transactionHash, authenticator);
      records.push(record);
    }

    // First insertion should succeed
    logger.info('First batch insertion...');
    const firstResult = await storage.putBatch(records);
    expect(firstResult).toBeTruthy();

    // Save original transaction hashes to verify they don't change
    const originalHashes = records.map((record) => ({
      requestId: record.requestId,
      transactionHash: record.transactionHash,
    }));

    // Second insertion of the same batch should also succeed, but won't modify records
    logger.info('Second batch insertion (same records)...');
    const secondResult = await storage.putBatch(records);
    expect(secondResult).toBeTruthy();

    // Now create records with the same request IDs but different transaction hashes
    const modifiedRecords: AggregatorRecord[] = [];
    for (const record of records) {
      const newTransactionHash = await new DataHasher(HashAlgorithm.SHA256)
        .update(new Uint8Array([100, 110, 120]))
        .digest();
      const newAuthenticator = await Authenticator.create(
        signingService,
        newTransactionHash,
        record.authenticator.stateHash,
      );
      modifiedRecords.push(new AggregatorRecord(record.requestId, newTransactionHash, newAuthenticator));
    }

    // This should succeed but won't update existing records due to $setOnInsert
    logger.info('Third batch insertion (same request IDs, different transaction hashes)...');
    const thirdResult = await storage.putBatch(modifiedRecords);
    expect(thirdResult).toBeTruthy();

    // Verify the records still have their original transaction hashes
    for (const original of originalHashes) {
      const retrieved = await storage.get(original.requestId);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.requestId.toBigInt()).toEqual(original.requestId.toBigInt());
      // Should still have the original transaction hash, not the modified one
      expect(retrieved!.transactionHash.equals(original.transactionHash)).toBeTruthy();
    }

    // Add a new record with a completely new requestId - this should be inserted
    const stateHash = await new DataHasher(HashAlgorithm.SHA256).update(new Uint8Array([99, 99, 99])).digest();
    const transactionHash = await new DataHasher(HashAlgorithm.SHA256).update(new Uint8Array([88, 88, 88])).digest();
    const requestId = await RequestId.create(signingService.publicKey, stateHash);
    const authenticator = await Authenticator.create(signingService, transactionHash, stateHash);
    const newRecord = new AggregatorRecord(requestId, transactionHash, authenticator);

    const mixedBatch = [...modifiedRecords, newRecord];
    logger.info('Fourth batch insertion (mix of existing and new records)...');
    const fourthResult = await storage.putBatch(mixedBatch);
    expect(fourthResult).toBeTruthy();

    // Verify the new record was inserted
    const retrievedNew = await storage.get(requestId);
    expect(retrievedNew).not.toBeNull();
    expect(retrievedNew!.transactionHash.equals(transactionHash)).toBeTruthy();

    // Count total records - should be 4 (original 3 + new 1)
    const recordCount = await mongoose.connection.collection('aggregatorrecords').countDocuments();
    expect(recordCount).toBe(4);
  });

  it('Get multiple records by request IDs', async () => {
    await mongoose.connection.collection('aggregatorrecords').deleteMany({});

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

    logger.info('Storing records in batch...');
    await storage.putBatch(records);

    logger.info('Retrieving all records with getByRequestIds...');
    const allRetrieved = await storage.getByRequestIds(requestIds);
    expect(allRetrieved.length).toBe(5);

    // Verify each record matches the original
    for (let i = 0; i < records.length; i++) {
      const originalRecord = records[i];
      const retrievedRecord = allRetrieved.find((r) => r.requestId.toBigInt() === originalRecord.requestId.toBigInt());

      expect(retrievedRecord).toBeDefined();
      expect(retrievedRecord!.transactionHash.equals(originalRecord.transactionHash)).toBeTruthy();
      expect(HexConverter.encode(retrievedRecord!.authenticator.signature.bytes)).toEqual(
        HexConverter.encode(originalRecord.authenticator.signature.bytes),
      );
      expect(HexConverter.encode(retrievedRecord!.authenticator.publicKey)).toEqual(
        HexConverter.encode(originalRecord.authenticator.publicKey),
      );
      expect(retrievedRecord!.authenticator.stateHash.equals(originalRecord.authenticator.stateHash)).toBeTruthy();
      expect(retrievedRecord!.authenticator.algorithm).toEqual(originalRecord.authenticator.algorithm);
    }

    logger.info('Retrieving subset of records...');
    const subsetRequestIds = [requestIds[1], requestIds[3]];
    const subsetRetrieved = await storage.getByRequestIds(subsetRequestIds);
    expect(subsetRetrieved.length).toBe(2);

    const subsetRequestIdValues = subsetRequestIds.map((id) => id.toBigInt());
    for (const retrievedRecord of subsetRetrieved) {
      expect(subsetRequestIdValues).toContain(retrievedRecord.requestId.toBigInt());
    }

    logger.info('Testing with empty request IDs array...');
    const emptyResult = await storage.getByRequestIds([]);
    expect(emptyResult).toEqual([]);

    logger.info('Testing with non-existent request ID...');
    const nonExistentStateHash = await new DataHasher(HashAlgorithm.SHA256)
      .update(new Uint8Array([99, 99, 99]))
      .digest();
    const nonExistentRequestId = await RequestId.create(signingService.publicKey, nonExistentStateHash);
    const nonExistentResult = await storage.getByRequestIds([nonExistentRequestId]);
    expect(nonExistentResult.length).toBe(0);
  });

  it('Should preserve signature recovery byte when storing and retrieving', async () => {
    await mongoose.connection.collection('aggregatorrecords').deleteMany({});

    // Create a signature with a specific recovery byte
    const sigBytes = new Uint8Array(64).fill(1);
    const recoveryByte = 27; // Non-zero recovery value
    const originalSignature = new Signature(sigBytes, recoveryByte);
    const encodedOriginal = originalSignature.encode();

    const storage = new AggregatorRecordStorage();
    const signingService = await SigningService.createFromSecret(SigningService.generatePrivateKey());
    const stateHash = await new DataHasher(HashAlgorithm.SHA256).update(new Uint8Array([1, 2, 3])).digest();
    const transactionHash = await new DataHasher(HashAlgorithm.SHA256).update(new Uint8Array([4, 5, 6])).digest();
    const requestId = await RequestId.create(signingService.publicKey, stateHash);

    const authenticator = new Authenticator('secp256k1', signingService.publicKey, originalSignature, stateHash);
    const record = new AggregatorRecord(requestId, transactionHash, authenticator);

    await storage.put(record);
    const retrieved = await storage.get(requestId);

    expect(retrieved).not.toBeNull();
    assert(retrieved);

    // Verify the signature bytes are preserved
    expect(HexConverter.encode(retrieved.authenticator.signature.bytes)).toEqual(
      HexConverter.encode(originalSignature.bytes),
    );

    // Verify the recovery byte is preserved by comparing the encoded signatures
    const encodedRetrieved = retrieved.authenticator.signature.encode();
    expect(encodedRetrieved[encodedRetrieved.length - 1]).toEqual(recoveryByte);
    expect(HexConverter.encode(encodedRetrieved)).toEqual(HexConverter.encode(encodedOriginal));
  });

  it('Should deserialize records with binary-encoded data from MongoDB', async () => {
    await mongoose.connection.collection('aggregatorrecords').deleteMany({});

    const requestIdFromJson = RequestId.fromJSON(
      '000042500f62a4efc41ad1fd1ce44cd42c0824e2128d37a53ac422fa51cb72488b30',
    );
    const testData = {
      _id: new mongoose.Types.ObjectId('6826fe3ea9ca86eff83fef56'),
      requestId: new Binary(Buffer.from(BigintConverter.encode(requestIdFromJson.toBigInt()))),
      transactionHash: new Binary(Buffer.from('AACzHOIylRlYHOOXctUBFHB1KLEpacoapZ8Z98+85DrH2Q==', 'base64')),
      authenticator: {
        algorithm: 'secp256k1',
        publicKey: new Binary(Buffer.from('Aicfou2gts+5lbH431qyvato70L9yU1vu7Sy7a6tuBA/', 'base64')),
        signature: new Binary(
          Buffer.from(
            '3oW/7TSW8XtFqzGoyNIAWkwIiGqSmEDPEllnu5elos4tVvit/kbrXtFq2AYKW9GldUb1lHzAaFdYC6H36Ia5wwA=',
            'base64',
          ),
        ),
        stateHash: new Binary(Buffer.from('AAD6KSDG8uqIVZi2fmPil8q3+oI4sAUlh+PqnRDf5b7JGA==', 'base64')),
      },
      sequenceId: 1,
      __v: 0,
    };

    logger.info('Inserting test data directly into MongoDB...');
    await mongoose.connection.collection('aggregatorrecords').insertOne(testData);

    const storage = new AggregatorRecordStorage();

    logger.info('Retrieving record from MongoDB...');
    const retrieved = await storage.get(requestIdFromJson);

    expect(retrieved).not.toBeNull();
    assert(retrieved);

    logger.info('Verifying binary data deserialization...');

    expect(retrieved.requestId.toJSON()).toEqual(
      '000042500f62a4efc41ad1fd1ce44cd42c0824e2128d37a53ac422fa51cb72488b30',
    );

    const expectedTransactionHash = Buffer.from('AACzHOIylRlYHOOXctUBFHB1KLEpacoapZ8Z98+85DrH2Q==', 'base64');
    expect(new Uint8Array(retrieved.transactionHash.imprint)).toEqual(new Uint8Array(expectedTransactionHash));

    expect(retrieved.authenticator.algorithm).toEqual('secp256k1');
    const expectedPublicKey = Buffer.from('Aicfou2gts+5lbH431qyvato70L9yU1vu7Sy7a6tuBA/', 'base64');
    expect(retrieved.authenticator.publicKey).toEqual(new Uint8Array(expectedPublicKey));
    const expectedSignature = Buffer.from(
      '3oW/7TSW8XtFqzGoyNIAWkwIiGqSmEDPEllnu5elos4tVvit/kbrXtFq2AYKW9GldUb1lHzAaFdYC6H36Ia5wwA=',
      'base64',
    );
    expect(retrieved.authenticator.signature.encode()).toEqual(new Uint8Array(expectedSignature));
    const expectedStateHash = Buffer.from('AAD6KSDG8uqIVZi2fmPil8q3+oI4sAUlh+PqnRDf5b7JGA==', 'base64');
    expect(new Uint8Array(retrieved.authenticator.stateHash.imprint)).toEqual(new Uint8Array(expectedStateHash));

    logger.info('Binary data successfully deserialized with commons library');

    // Verify we can also retrieve using getByRequestIds
    const batchRetrieved = await storage.getByRequestIds([requestIdFromJson]);
    expect(batchRetrieved.length).toBe(1);
    expect(batchRetrieved[0].requestId.toJSON()).toEqual(
      '000042500f62a4efc41ad1fd1ce44cd42c0824e2128d37a53ac422fa51cb72488b30',
    );
  });
});
