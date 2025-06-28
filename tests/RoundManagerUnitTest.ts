import { HashAlgorithm } from '@unicitylabs/commons/lib/hash/HashAlgorithm.js';
import { SparseMerkleTree } from '@unicitylabs/commons/lib/smt/SparseMerkleTree.js';
import mongoose from 'mongoose';

import { IAggregatorConfig } from '../src/AggregatorGateway.js';
import { CommitmentStorage } from '../src/commitment/CommitmentStorage.js';
import { MockAlphabillClient } from './consensus/alphabill/MockAlphabillClient.js';
import { connectToSharedMongo, disconnectFromSharedMongo, generateTestCommitments, clearAllCollections } from './TestUtils.js';
import { BlockStorage } from '../src/hashchain/BlockStorage.js';
import logger from '../src/logger.js';
import { AggregatorRecordStorage } from '../src/records/AggregatorRecordStorage.js';
import { BlockRecordsStorage } from '../src/records/BlockRecordsStorage.js';
import { RoundManager } from '../src/RoundManager.js';
import { Smt } from '../src/smt/Smt.js';
import { SmtStorage } from '../src/smt/SmtStorage.js';
import * as TransactionUtils from '../src/transaction/TransactionUtils.js';

describe('Round Manager Tests', () => {
  jest.setTimeout(120000);

  let mongoUri: string;
  let roundManager: RoundManager;
  let blockStorage: BlockStorage;
  let recordStorage: AggregatorRecordStorage;
  let commitmentStorage: CommitmentStorage;
  let smtStorage: SmtStorage;
  let smt: SparseMerkleTree;
  let alphabillClient: MockAlphabillClient;
  let blockRecordsStorage: BlockRecordsStorage;

  beforeAll(async () => {
    mongoUri = await connectToSharedMongo(false);
    logger.info(`Connected to shared in-memory MongoDB at ${mongoUri}`);
  });

  afterAll(async () => {
    await disconnectFromSharedMongo();
    logger.info('Disconnected from shared in-memory MongoDB');
  });

  beforeEach(async () => {
    await clearAllCollections();

    const config: IAggregatorConfig = {
      chainId: 1,
      version: 1,
      forkId: 1,
      port: 9876,
      initialBlockHash: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
    };

    alphabillClient = new MockAlphabillClient();
    blockStorage = new BlockStorage();
    recordStorage = new AggregatorRecordStorage();
    commitmentStorage = new CommitmentStorage();
    blockRecordsStorage = await BlockRecordsStorage.create('test-server');
    smtStorage = new SmtStorage();
    smt = new SparseMerkleTree(HashAlgorithm.SHA256);
    const smtWrapper = new Smt(smt);

    roundManager = new RoundManager(
      config,
      alphabillClient,
      smtWrapper,
      blockStorage,
      recordStorage,
      blockRecordsStorage,
      commitmentStorage,
      smtStorage,
    );
  });

  it('should resume block creation from incomplete state after a failure', async () => {
    const commitments = await generateTestCommitments(5);

    for (const commitment of commitments) {
      await commitmentStorage.put(commitment);
    }

    const initialCount = await mongoose.connection.collection('commitments').countDocuments();
    expect(initialCount).toBe(5);

    jest.spyOn(smtStorage, 'putBatch').mockImplementationOnce(() => {
      return Promise.reject(new Error('Simulated SMT storage failure'));
    });

    await expect(roundManager.createBlock()).rejects.toThrow('Simulated SMT storage failure');

    jest.restoreAllMocks();

    const block = await roundManager.createBlock();

    expect(block).toBeDefined();
    expect(block.index).toBe(1n);
    expect(roundManager.getCommitmentCount()).toBe(5);

    const afterProcessCount = await mongoose.connection.collection('commitments').countDocuments();
    expect(afterProcessCount).toBe(5);
  });

  it('should process block creation in a single transaction', async () => {
    const commitments = await generateTestCommitments(3);

    for (const commitment of commitments) {
      await commitmentStorage.put(commitment);
    }

    const withTransactionSpy = jest.spyOn(TransactionUtils, 'withTransaction');

    const block = await roundManager.createBlock();

    expect(block).toBeDefined();
    expect(block.index).toBe(1n);

    // 1 for storing leaves, 1 for storing block and block records
    expect(withTransactionSpy).toHaveBeenCalledTimes(2);

    const storedBlock = await blockStorage.get(1n);
    expect(storedBlock).toBeDefined();

    const blockRecords = await blockRecordsStorage.get(1n);
    expect(blockRecords).toBeDefined();
    expect(blockRecords?.requestIds.length).toBe(3);

    expect(roundManager.getCommitmentCount()).toBe(3);

    withTransactionSpy.mockRestore();
  });

  it('should roll back all changes when transaction fails', async () => {
    const commitments = await generateTestCommitments(3);

    for (const commitment of commitments) {
      await commitmentStorage.put(commitment);
    }

    // Allow blockStorage.put to succeed but make blockRecordsStorage.put fail
    // This tests that even successful operations are rolled back when the transaction fails
    jest.spyOn(blockRecordsStorage, 'put').mockImplementationOnce(() => {
      throw new Error('Simulated block records storage failure');
    });

    const blockStorageSpy = jest.spyOn(blockStorage, 'put');
    const commitmentConfirmSpy = jest.spyOn(commitmentStorage, 'confirmBlockProcessed');

    // Try to create a block - should fail
    await expect(roundManager.createBlock()).rejects.toThrow('Simulated block records storage failure');

    // Verify operations were attempted in correct order
    expect(blockStorageSpy).toHaveBeenCalled(); // First operation should succeed
    expect(blockRecordsStorage.put).toHaveBeenCalled(); // Second operation should fail
    expect(commitmentConfirmSpy).not.toHaveBeenCalled(); // Third operation shouldn't be called after failure

    // Check database to confirm transaction was rolled back
    const blockCount = await mongoose.connection.collection('blocks').countDocuments();
    expect(blockCount).toBe(0);

    const blockRecordsCount = await mongoose.connection.collection('blockrecords').countDocuments();
    expect(blockRecordsCount).toBe(0);

    // Verify commitment counter wasn't incremented
    expect(roundManager.getCommitmentCount()).toBe(0);

    jest.restoreAllMocks();
  });
});
