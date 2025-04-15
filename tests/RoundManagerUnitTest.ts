import { Authenticator } from '@unicitylabs/commons/lib/api/Authenticator.js';
import { RequestId } from '@unicitylabs/commons/lib/api/RequestId.js';
import { DataHash } from '@unicitylabs/commons/lib/hash/DataHash.js';
import { HashAlgorithm } from '@unicitylabs/commons/lib/hash/HashAlgorithm.js';
import { Signature } from '@unicitylabs/commons/lib/signing/Signature.js';
import { SparseMerkleTree } from '@unicitylabs/commons/lib/smt/SparseMerkleTree.js';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

import { IAggregatorConfig } from '../src/AggregatorGateway.js';
import { Commitment } from '../src/commitment/Commitment.js';
import { CommitmentStorage } from '../src/commitment/CommitmentStorage.js';
import { MockAlphabillClient } from './consensus/alphabill/MockAlphabillClient.js';
import { BlockStorage } from '../src/hashchain/BlockStorage.js';
import logger from '../src/logger.js';
import { AggregatorRecordStorage } from '../src/records/AggregatorRecordStorage.js';
import { BlockRecordsStorage } from '../src/records/BlockRecordsStorage.js';
import { RoundManager } from '../src/RoundManager.js';
import { SmtStorage } from '../src/smt/SmtStorage.js';

describe('Round Manager Tests', () => {
  jest.setTimeout(90000);

  let mongoServer: MongoMemoryServer;
  let mongoUri: string;
  let roundManager: RoundManager;
  let blockStorage: BlockStorage;
  let recordStorage: AggregatorRecordStorage;
  let commitmentStorage: CommitmentStorage;
  let smtStorage: SmtStorage;
  let smt: SparseMerkleTree;
  let alphabillClient: MockAlphabillClient;
  let blockRecordsStorage: BlockRecordsStorage;
  // Create test commitments to use in tests
  const createTestCommitments = async (count: number): Promise<Commitment[]> => {
    const commitments: Commitment[] = [];

    for (let i = 0; i < count; i++) {
      // Use predictable, unique values for testing
      const stateHashBytes = new TextEncoder().encode(`state-${i}-test`);
      const stateHash = new DataHash(HashAlgorithm.SHA256, stateHashBytes);
      const requestId = await RequestId.create(new Uint8Array(32), stateHash);

      const txHashBytes = new TextEncoder().encode(`tx-${i}-test`);
      const transactionHash = new DataHash(HashAlgorithm.SHA256, txHashBytes);

      // Create a simple authenticator
      const publicKey = new Uint8Array(32);
      const sigBytes = new Uint8Array(65);
      sigBytes[64] = 0;
      const signature = new Signature(sigBytes.slice(0, 64), sigBytes[64]);

      const authenticator = new Authenticator(publicKey, 'mock-algo', signature, stateHash);

      commitments.push(new Commitment(requestId, transactionHash, authenticator));
    }

    return commitments;
  };

  beforeAll(async () => {
    // Set up the in-memory MongoDB database
    mongoServer = await MongoMemoryServer.create();
    mongoUri = mongoServer.getUri();
    await mongoose.connect(mongoUri);
    logger.info(`Connected to in-memory MongoDB at ${mongoUri}`);
  });

  afterAll(async () => {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
    if (mongoServer) {
      await mongoServer.stop();
    }
    logger.info('Disconnected from in-memory MongoDB');
  });

  beforeEach(async () => {
    // Clear all collections
    await mongoose.connection.dropDatabase();

    const config: IAggregatorConfig = {
      chainId: 1,
      version: 1,
      forkId: 1,
      port: 9876,
      initialBlockHash: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
    };

    // Initialize all dependencies
    alphabillClient = new MockAlphabillClient();
    blockStorage = new BlockStorage();
    recordStorage = new AggregatorRecordStorage();
    commitmentStorage = new CommitmentStorage();
    blockRecordsStorage = new BlockRecordsStorage();
    smtStorage = new SmtStorage();
    smt = await SparseMerkleTree.create(HashAlgorithm.SHA256);

    // Create RoundManager with real dependencies
    roundManager = new RoundManager(
      config,
      alphabillClient,
      smt,
      blockStorage,
      recordStorage,
      blockRecordsStorage,
      commitmentStorage,
      smtStorage,
    );
  });

  it('should resume block creation from incomplete state after a failure', async () => {
    // Create and submit test commitments to storage
    const commitments = await createTestCommitments(5);

    // Submit the commitments directly to the storage
    for (const commitment of commitments) {
      await commitmentStorage.put(commitment);
    }

    // Verify commitments are in the database before we start
    const initialCount = await mongoose.connection.collection('commitments').countDocuments();
    expect(initialCount).toBe(5);

    // Make SMT storage fail during first attempt
    const smtStorageSpy = jest.spyOn(smtStorage, 'putBatch');
    smtStorageSpy.mockRejectedValueOnce(new Error('Simulated SMT storage failure'));

    // Expect the first createBlock attempt to fail
    await expect(roundManager.createBlock()).rejects.toThrow('Simulated SMT storage failure');

    // Clear the SMT storage failure mock
    smtStorageSpy.mockRestore();

    // Now createBlock should succeed and process the same commitments
    const block = await roundManager.createBlock();

    // Verify block was created
    expect(block).toBeDefined();
    expect(block.index).toBe(1n);

    // Commit counter should reflect the successful attempt
    expect(roundManager.getCommitmentCount()).toBe(5);

    // Commitments should be marked as processed
    const afterProcessCount = await mongoose.connection.collection('commitments').countDocuments();
    // We still expect commitments to be in the database, but they should be processed
    expect(afterProcessCount).toBe(5);
  });
});
