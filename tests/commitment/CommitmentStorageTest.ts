import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { Authenticator } from '@unicitylabs/commons/lib/api/Authenticator.js';
import { RequestId } from '@unicitylabs/commons/lib/api/RequestId.js';
import { DataHash } from '@unicitylabs/commons/lib/hash/DataHash.js';
import { HashAlgorithm } from '@unicitylabs/commons/lib/hash/HashAlgorithm.js';
import { SigningService } from '@unicitylabs/commons/lib/signing/SigningService.js';
import { v4 as uuidv4 } from 'uuid';

import { CommitmentStorage } from '../../src/commitment/CommitmentStorage.js';
import { Commitment } from '../../src/commitment/Commitment.js';

describe('CommitmentStorage Tests', () => {
  jest.setTimeout(30000);
  
  let mongoServer: MongoMemoryServer;
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
    mongoServer = await MongoMemoryServer.create();
    const uri = mongoServer.getUri();
    await mongoose.connect(uri);
    
    storage = new CommitmentStorage();
  });
  
  afterAll(async () => {
    if (mongoose.connection) {
      await mongoose.connection.close();
    }
    if (mongoServer) {
      await mongoServer.stop();
    }
  });
  
  beforeEach(async () => {
    if (mongoose.connection && mongoose.connection.db) {
      await mongoose.connection.db.dropDatabase();
    }
  });
  
  it('should store and retrieve commitment with correct hash imprints', async () => {
    const commitment = await generateTestCommitment();
    
    const originalTransactionHashImprint = new Uint8Array(commitment.transactionHash.imprint);
    const originalStateHashImprint = new Uint8Array(commitment.authenticator.stateHash.imprint);
    const originalRequestId = commitment.requestId.toDto();
    const originalSignature = new Uint8Array(commitment.authenticator.signature.encode());
    const originalPublicKey = new Uint8Array(commitment.authenticator.publicKey);
    const originalAlgorithm = commitment.authenticator.algorithm;
    
    const storeResult = await storage.put(commitment);
    expect(storeResult).toBeTruthy();
    
    const retrievedCommitments = await storage.getCommitmentsForBlock();
    expect(retrievedCommitments).toHaveLength(1);
    
    const retrievedCommitment = retrievedCommitments[0];
    
    expect(retrievedCommitment.requestId.toDto()).toEqual(originalRequestId);
    expect(new Uint8Array(retrievedCommitment.transactionHash.imprint)).toEqual(originalTransactionHashImprint);
    expect(new Uint8Array(retrievedCommitment.authenticator.stateHash.imprint)).toEqual(originalStateHashImprint);
    expect(new Uint8Array(retrievedCommitment.authenticator.signature.encode())).toEqual(originalSignature);
    expect(new Uint8Array(retrievedCommitment.authenticator.publicKey)).toEqual(originalPublicKey);
    expect(retrievedCommitment.authenticator.algorithm).toEqual(originalAlgorithm);
    expect(retrievedCommitment.transactionHash.algorithm).toEqual(commitment.transactionHash.algorithm);
    expect(retrievedCommitment.authenticator.stateHash.algorithm).toEqual(commitment.authenticator.stateHash.algorithm);
    expect(retrievedCommitment.transactionHash.toString()).toEqual(commitment.transactionHash.toString());
    expect(retrievedCommitment.authenticator.stateHash.toString()).toEqual(commitment.authenticator.stateHash.toString());
  });
  
  it('should store and retrieve multiple commitments while preserving hash imprints', async () => {
    const commitmentCount = 5;
    const commitments: Commitment[] = [];
    
    for (let i = 0; i < commitmentCount; i++) {
      commitments.push(await generateTestCommitment());
    }
    
    const originalValues = commitments.map(c => ({
      requestId: c.requestId.toDto(),
      transactionHashImprint: new Uint8Array(c.transactionHash.imprint),
      stateHashImprint: new Uint8Array(c.authenticator.stateHash.imprint),
      transactionHashString: c.transactionHash.toString(),
      stateHashString: c.authenticator.stateHash.toString()
    }));
    
    for (const commitment of commitments) {
      await storage.put(commitment);
    }
    
    const retrievedCommitments = await storage.getCommitmentsForBlock();
    expect(retrievedCommitments).toHaveLength(commitmentCount);
    
    const sortedOriginalValues = [...originalValues].sort((a, b) => a.requestId.localeCompare(b.requestId));
    const sortedRetrievedCommitments = [...retrievedCommitments].sort((a, b) => 
      a.requestId.toDto().localeCompare(b.requestId.toDto())
    );
    
    for (let i = 0; i < commitmentCount; i++) {
      const original = sortedOriginalValues[i];
      const retrieved = sortedRetrievedCommitments[i];
      
      expect(retrieved.requestId.toDto()).toEqual(original.requestId);
      expect(new Uint8Array(retrieved.transactionHash.imprint)).toEqual(original.transactionHashImprint);
      expect(new Uint8Array(retrieved.authenticator.stateHash.imprint)).toEqual(original.stateHashImprint);
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
    
    const firstBatchValues = firstBatch.map(c => ({
      requestId: c.requestId.toDto(),
      transactionHashImprint: new Uint8Array(c.transactionHash.imprint)
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
    
    const secondBatchValues = secondBatch.map(c => ({
      requestId: c.requestId.toDto(),
      transactionHashImprint: new Uint8Array(c.transactionHash.imprint)
    }));
    
    const retrievedSecondBatch = await storage.getCommitmentsForBlock();
    expect(retrievedSecondBatch).toHaveLength(secondBatchSize);
    
    const secondBatchRequestIds = retrievedSecondBatch.map(c => c.requestId.toDto());
    for (const value of firstBatchValues) {
      expect(secondBatchRequestIds).not.toContain(value.requestId);
    }
    
    for (const commitment of retrievedSecondBatch) {
      const originalValue = secondBatchValues.find(v => v.requestId === commitment.requestId.toDto());
      expect(originalValue).toBeDefined();
      expect(new Uint8Array(commitment.transactionHash.imprint)).toEqual(originalValue!.transactionHashImprint);
    }
  });
});