import { HashAlgorithm } from '@unicitylabs/commons/lib/hash/HashAlgorithm.js';
import { SparseMerkleTree } from '@unicitylabs/commons/lib/smt/SparseMerkleTree.js';
import mongoose from 'mongoose';

import { IAggregatorConfig } from '../src/AggregatorGateway.js';
import { CommitmentStorage } from '../src/commitment/CommitmentStorage.js';
import { MockAlphabillClient } from './consensus/alphabill/MockAlphabillClient.js';
import { IReplicaSet, setupReplicaSet, generateTestCommitments } from './TestUtils.js';
import { BlockStorage } from '../src/hashchain/BlockStorage.js';
import logger from '../src/logger.js';
import { AggregatorRecordStorage } from '../src/records/AggregatorRecordStorage.js';
import { BlockRecordsStorage } from '../src/records/BlockRecordsStorage.js';
import { RoundManager } from '../src/RoundManager.js';
import { Smt } from '../src/smt/Smt.js';
import { SmtStorage } from '../src/smt/SmtStorage.js';

describe('Round Manager Tests', () => {
  jest.setTimeout(120000);

  let replicaSet: IReplicaSet;
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
    replicaSet = await setupReplicaSet('rm-test-');
    mongoUri = replicaSet.uri;
    logger.info(`Connecting to MongoDB replica set at ${mongoUri}`);
    await mongoose.connect(mongoUri);
  });

  afterAll(async () => {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }

    if (replicaSet?.containers) {
      logger.info('Stopping replica set containers...');
      for (const container of replicaSet.containers) {
        await container.stop();
      }
    }

    logger.info('Disconnected from MongoDB replica set');
  });

  beforeEach(async () => {
    if (mongoose.connection.readyState === 1) {
      const collections = await mongoose.connection.db!.collections();
      for (const collection of collections) {
        await collection.deleteMany({});
      }
    }

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
    blockRecordsStorage = new BlockRecordsStorage();
    smtStorage = new SmtStorage();
    smt = await SparseMerkleTree.create(HashAlgorithm.SHA256);
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
});
