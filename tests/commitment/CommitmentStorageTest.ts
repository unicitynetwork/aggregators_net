import { Authenticator } from '@unicitylabs/commons/lib/api/Authenticator.js';
import { RequestId } from '@unicitylabs/commons/lib/api/RequestId.js';
import { DataHash } from '@unicitylabs/commons/lib/hash/DataHash.js';
import { HashAlgorithm } from '@unicitylabs/commons/lib/hash/HashAlgorithm.js';
import { SigningService } from '@unicitylabs/commons/lib/signing/SigningService.js';
import { Binary } from 'mongodb';
import mongoose from 'mongoose';
import { v4 as uuidv4 } from 'uuid';

import { Commitment } from '../../src/commitment/Commitment.js';
import { CommitmentStorage } from '../../src/commitment/CommitmentStorage.js';
import { connectToSharedMongo, disconnectFromSharedMongo, clearAllCollections } from '../TestUtils.js';

describe('CommitmentStorage Tests', () => {
  jest.setTimeout(30000);

  let storage: CommitmentStorage;

  async function generateTestCommitment(): Promise<Commitment> {
    const signingService = await SigningService.createFromSecret(SigningService.generatePrivateKey());

    const stateHashBytes = new TextEncoder().encode(`state-${uuidv4()}`);
    const stateHash = new DataHash(HashAlgorithm.SHA256, stateHashBytes);
    const requestId = await RequestId.create(signingService.publicKey, stateHash);

    const txHashBytes = new TextEncoder().encode(`tx-${uuidv4()}`);
    const transactionHash = new DataHash(HashAlgorithm.SHA256, txHashBytes);

    const authenticator = await Authenticator.create(signingService, transactionHash, stateHash);

    return new Commitment(requestId, transactionHash, authenticator);
  }

  beforeAll(async () => {
    await connectToSharedMongo();
    storage = new CommitmentStorage();
  });

  afterAll(async () => {
    await disconnectFromSharedMongo();
  });

  afterEach(async () => {
    await clearAllCollections();
  });

  it('should store and retrieve commitment with correct hash imprints', async () => {
    const commitment = await generateTestCommitment();

    const originalTransactionHashImprint = new Uint8Array(commitment.transactionHash.imprint);
    const originalStateHashImprint = new Uint8Array(commitment.authenticator.stateHash.imprint);
    const originalRequestId = commitment.requestId.toJSON();
    const originalSignatureWithoutRecovery = new Uint8Array(commitment.authenticator.signature.bytes);

    const originalPublicKey = new Uint8Array(commitment.authenticator.publicKey);
    const originalAlgorithm = commitment.authenticator.algorithm;

    const storeResult = await storage.put(commitment);
    expect(storeResult).toBeTruthy();

    const retrievedCommitments = await storage.getCommitmentsForBlock();
    expect(retrievedCommitments).toHaveLength(1);

    const retrievedCommitment = retrievedCommitments[0];

    expect(retrievedCommitment.requestId.toJSON()).toEqual(originalRequestId);
    expect(new Uint8Array(retrievedCommitment.transactionHash.imprint)).toEqual(originalTransactionHashImprint);
    expect(new Uint8Array(retrievedCommitment.authenticator.stateHash.imprint)).toEqual(originalStateHashImprint);

    const retrievedSignatureWithoutRecovery = new Uint8Array(retrievedCommitment.authenticator.signature.bytes);
    expect(retrievedSignatureWithoutRecovery).toEqual(originalSignatureWithoutRecovery);

    expect(retrievedCommitment.authenticator.publicKey).toEqual(originalPublicKey);
    expect(retrievedCommitment.authenticator.algorithm).toEqual(originalAlgorithm);
    expect(retrievedCommitment.transactionHash.algorithm).toEqual(commitment.transactionHash.algorithm);
    expect(retrievedCommitment.authenticator.stateHash.algorithm).toEqual(commitment.authenticator.stateHash.algorithm);
    expect(retrievedCommitment.transactionHash.toString()).toEqual(commitment.transactionHash.toString());
    expect(retrievedCommitment.authenticator.stateHash.toString()).toEqual(
      commitment.authenticator.stateHash.toString(),
    );
  });

  it('should store and retrieve multiple commitments while preserving hash imprints', async () => {
    const commitmentCount = 5;
    const commitments: Commitment[] = [];

    for (let i = 0; i < commitmentCount; i++) {
      commitments.push(await generateTestCommitment());
    }

    const originalValues = commitments.map((c) => ({
      requestId: c.requestId.toJSON(),
      transactionHashImprint: new Uint8Array(c.transactionHash.imprint),
      stateHashImprint: new Uint8Array(c.authenticator.stateHash.imprint),
      signatureBytes: new Uint8Array(c.authenticator.signature.bytes),
      transactionHashString: c.transactionHash.toString(),
      stateHashString: c.authenticator.stateHash.toString(),
    }));

    for (const commitment of commitments) {
      await storage.put(commitment);
    }

    const retrievedCommitments = await storage.getCommitmentsForBlock();
    expect(retrievedCommitments).toHaveLength(commitmentCount);

    const sortedOriginalValues = [...originalValues].sort((a, b) => a.requestId.localeCompare(b.requestId));
    const sortedRetrievedCommitments = [...retrievedCommitments].sort((a, b) =>
      a.requestId.toJSON().localeCompare(b.requestId.toJSON()),
    );

    for (let i = 0; i < commitmentCount; i++) {
      const original = sortedOriginalValues[i];
      const retrieved = sortedRetrievedCommitments[i];

      expect(retrieved.requestId.toJSON()).toEqual(original.requestId);
      expect(new Uint8Array(retrieved.transactionHash.imprint)).toEqual(original.transactionHashImprint);
      expect(new Uint8Array(retrieved.authenticator.stateHash.imprint)).toEqual(original.stateHashImprint);
      expect(new Uint8Array(retrieved.authenticator.signature.bytes)).toEqual(original.signatureBytes);
      expect(retrieved.transactionHash.toString()).toEqual(original.transactionHashString);
      expect(retrieved.authenticator.stateHash.toString()).toEqual(original.stateHashString);
    }
  });

  it('should confirm block processed and retrieve next batch correctly', async () => {
    const firstBatchSize = 3;
    const firstBatch: Commitment[] = [];

    for (let i = 0; i < firstBatchSize; i++) {
      const commitment = await generateTestCommitment();
      firstBatch.push(commitment);
      await storage.put(commitment);
    }

    const firstBatchValues = firstBatch.map((c) => ({
      requestId: c.requestId.toJSON(),
      transactionHashImprint: new Uint8Array(c.transactionHash.imprint),
    }));

    const retrievedFirstBatch = await storage.getCommitmentsForBlock();
    expect(retrievedFirstBatch).toHaveLength(firstBatchSize);

    const confirmResult = await storage.confirmBlockProcessed();
    expect(confirmResult).toBeTruthy();

    const secondBatchSize = 2;
    const secondBatch: Commitment[] = [];

    for (let i = 0; i < secondBatchSize; i++) {
      const commitment = await generateTestCommitment();
      secondBatch.push(commitment);
      await storage.put(commitment);
    }

    const secondBatchValues = secondBatch.map((c) => ({
      requestId: c.requestId.toJSON(),
      transactionHashImprint: new Uint8Array(c.transactionHash.imprint),
    }));

    const retrievedSecondBatch = await storage.getCommitmentsForBlock();
    expect(retrievedSecondBatch).toHaveLength(secondBatchSize);

    const secondBatchRequestIds = retrievedSecondBatch.map((c) => c.requestId.toJSON());
    for (const value of firstBatchValues) {
      expect(secondBatchRequestIds).not.toContain(value.requestId);
    }

    for (const commitment of retrievedSecondBatch) {
      const originalValue = secondBatchValues.find((v) => v.requestId === commitment.requestId.toJSON());
      expect(originalValue).toBeDefined();
      expect(new Uint8Array(commitment.transactionHash.imprint)).toEqual(originalValue!.transactionHashImprint);
    }
  });

  it('Should deserialize commitments with binary-encoded data from MongoDB', async () => {
    const testData = {
      _id: new mongoose.Types.ObjectId('681473d410effd5dbc73f88f'),
      requestId: '000003877b9912cd053c00a9325e7d2802125437c3515aeef1f5a6ace3c986e463c3',
      transactionHash: new Binary(Buffer.from('AABZgwTQahvgy3R0aNKjUMAl4NhEVN55tT/8gsFAf7x1OQ==', 'base64')),
      authenticator: {
        algorithm: 'secp256k1',
        publicKey: new Binary(Buffer.from('Albc+Z8hnwsSuIv4fvIcLajFbovOJhSsWBfkwg9wpr0i', 'base64')),
        signature: new Binary(
          Buffer.from(
            '1IxmtrNju19IIg1xZ8BxxFIECPPbGQNAiSinEg3s+HAVZmDMQzPyoBAxdYUZ5qryxzjJg/cYOzFayKNXSPIKxQE=',
            'base64',
          ),
        ),
        stateHash: new Binary(Buffer.from('AABZgwTQahvgy3R0aNKjUMAl4NhEVN55tT/8gsFAf7x1OQ==', 'base64')),
      },
      sequenceId: 1,
      __v: 0,
    };

    await mongoose.connection.collection('commitments').insertOne(testData);

    const retrievedCommitments = await storage.getCommitmentsForBlock();

    expect(retrievedCommitments).toHaveLength(1);
    const retrieved = retrievedCommitments[0];

    expect(retrieved.requestId.toJSON()).toEqual(
      '000003877b9912cd053c00a9325e7d2802125437c3515aeef1f5a6ace3c986e463c3',
    );

    const expectedTransactionHash = Buffer.from('AABZgwTQahvgy3R0aNKjUMAl4NhEVN55tT/8gsFAf7x1OQ==', 'base64');
    expect(new Uint8Array(retrieved.transactionHash.imprint)).toEqual(new Uint8Array(expectedTransactionHash));

    expect(retrieved.authenticator.algorithm).toEqual('secp256k1');
    const expectedPublicKey = Buffer.from('Albc+Z8hnwsSuIv4fvIcLajFbovOJhSsWBfkwg9wpr0i', 'base64');
    expect(retrieved.authenticator.publicKey).toEqual(new Uint8Array(expectedPublicKey));
    const expectedSignature = Buffer.from(
      '1IxmtrNju19IIg1xZ8BxxFIECPPbGQNAiSinEg3s+HAVZmDMQzPyoBAxdYUZ5qryxzjJg/cYOzFayKNXSPIKxQE=',
      'base64',
    );
    expect(retrieved.authenticator.signature.encode()).toEqual(new Uint8Array(expectedSignature));
    const expectedStateHash = Buffer.from('AABZgwTQahvgy3R0aNKjUMAl4NhEVN55tT/8gsFAf7x1OQ==', 'base64');
    expect(new Uint8Array(retrieved.authenticator.stateHash.imprint)).toEqual(new Uint8Array(expectedStateHash));
  });
});
