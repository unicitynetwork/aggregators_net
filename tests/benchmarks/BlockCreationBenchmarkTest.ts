import { performance } from 'perf_hooks';

import { Authenticator } from '@unicitylabs/commons/lib/api/Authenticator.js';
import { RequestId } from '@unicitylabs/commons/lib/api/RequestId.js';
import { DataHash } from '@unicitylabs/commons/lib/hash/DataHash.js';
import { HashAlgorithm } from '@unicitylabs/commons/lib/hash/HashAlgorithm.js';
import { Signature } from '@unicitylabs/commons/lib/signing/Signature.js';
import { SparseMerkleTree } from '@unicitylabs/commons/lib/smt/SparseMerkleTree.js';
import mongoose, { model } from 'mongoose';
import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';
import { v4 as uuidv4 } from 'uuid';

import { AggregatorStorage } from '../../src/AggregatorStorage.js';
import { Commitment } from '../../src/commitment/Commitment.js';
import { Block } from '../../src/hashchain/Block.js';
import logger from '../../src/Logger.js';
import { AggregatorRecord } from '../../src/records/AggregatorRecord.js';
import { RoundManager } from '../../src/RoundManager.js';
import { SmtNode } from '../../src/smt/SmtNode.js';
import { MockAlphabillClient } from '../consensus/alphabill/MockAlphabillClient.js';

interface BenchmarkResult {
  numCommitments: number;
  totalTimeMs: number;
  phases: {
    preparation: number;
    submitHash: number;
    blockFinalization: number;
    preparationDetails?: {
      getCommitments: number;
      smtOperations: number;
      recordStorage: number;
      smtLeafStorage: number;
    };
  };
}

class TimingMetricsCollector {
  private startTime: number = 0;
  private phaseStartTime: number = 0;
  private results: Record<string, number> = {};

  startBenchmark() {
    this.startTime = performance.now();
    this.results = {};
  }

  startPhase(phaseName: string) {
    this.phaseStartTime = performance.now();
    return () => this.endPhase(phaseName);
  }

  endPhase(phaseName: string) {
    this.results[phaseName] = performance.now() - this.phaseStartTime;
  }

  storeMetric(metricName: string, value: number) {
    this.results[metricName] = value;
  }

  getBenchmarkResult(numCommitments: number): BenchmarkResult {
    return {
      numCommitments,
      totalTimeMs: performance.now() - this.startTime,
      phases: {
        preparation: this.results['preparation'] || 0,
        submitHash: this.results['submitHash'] || 0,
        blockFinalization: this.results['blockFinalization'] || 0,
        preparationDetails: {
          getCommitments: this.results['getCommitments'] || 0,
          smtOperations: this.results['smtOperations'] || 0,
          recordStorage: this.results['recordStorage'] || 0,
          smtLeafStorage: this.results['smtLeafStorage'] || 0,
        },
      },
    };
  }
}

async function setupSingleNodeReplicaSet(): Promise<{ container: StartedTestContainer; uri: string }> {
  const port = 27999;

  const container = await new GenericContainer('mongo:8')
    .withName(`mongo-benchmark-${port}`)
    .withNetworkMode('host')
    .withCommand(['mongod', '--replSet', 'rs0', '--port', `${port}`, '--bind_ip', 'localhost'])
    .withStartupTimeout(120000)
    .withWaitStrategy(Wait.forLogMessage('Waiting for connections'))
    .start();

  const initResult = await container.exec([
    'mongosh',
    '--port',
    `${port}`,
    '--quiet',
    '--eval',
    `
    config = {
      _id: "rs0",
      members: [
        { _id: 0, host: "localhost:${port}" }
      ]
    };
    rs.initiate(config);
    `,
  ]);

  let isReady = false;
  const maxRetries = 30;
  let retriesCount = 0;

  while (!isReady && retriesCount < maxRetries) {
    try {
      const statusResult = await container.exec([
        'mongosh',
        '--port',
        `${port}`,
        '--quiet',
        '--eval',
        'JSON.stringify(rs.status())',
      ]);

      const rsStatus = JSON.parse(statusResult.output);
      const primaryMember = rsStatus.members?.find((m: any) => m.stateStr === 'PRIMARY');

      if (primaryMember) {
        isReady = true;
      } else {
        retriesCount++;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    } catch (error) {
      retriesCount++;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  if (!isReady) {
    throw new Error('Failed to initialize replica set after multiple attempts');
  }

  return {
    container,
    uri: `mongodb://localhost:${port}/benchmark?replicaSet=rs0`,
  };
}

describe('Block Creation Performance Benchmarks', () => {
  let mongoContainer: StartedTestContainer;
  let mongoUri: string;
  let storage: AggregatorStorage;
  let metrics: TimingMetricsCollector;
  let mockAlphabillClient: MockAlphabillClient;
  let smt: SparseMerkleTree;

  jest.setTimeout(300000);

  beforeAll(async () => {
    const replicaSet = await setupSingleNodeReplicaSet();
    mongoContainer = replicaSet.container;
    mongoUri = replicaSet.uri;
    storage = await AggregatorStorage.init(mongoUri);
    metrics = new TimingMetricsCollector();
  });

  afterAll(async () => {
    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.close();
    }

    if (storage) {
      await storage.close();
    }

    if (mongoContainer) {
      await mongoContainer.stop();
    }
  });

  beforeEach(async () => {
    smt = await SparseMerkleTree.create(HashAlgorithm.SHA256);
    mockAlphabillClient = new MockAlphabillClient();

    const originalSubmitHash = mockAlphabillClient.submitHash;
    mockAlphabillClient.submitHash = async function (hash) {
      const endPhase = metrics.startPhase('submitHash');
      const result = await originalSubmitHash.call(this, hash);
      endPhase();
      return result;
    };
  });

  afterEach(async () => {
    if (mongoose.connection.readyState === 1) {
      const CommitmentModel = model('Commitment');
      const AggregatorRecordModel = model('AggregatorRecord');
      const BlockModel = model('Block');

      await CommitmentModel.deleteMany({});
      await AggregatorRecordModel.deleteMany({});
      await BlockModel.deleteMany({});
    }
  });

  async function generateCommitments(count: number): Promise<Commitment[]> {
    const commitments: Commitment[] = [];

    for (let i = 0; i < count; i++) {
      const idStr = `state-${i}-${uuidv4()}`;
      const stateHashBytes = new TextEncoder().encode(idStr);
      const stateHash = new DataHash(HashAlgorithm.SHA256, stateHashBytes);

      const requestId = await RequestId.create(new Uint8Array(32), stateHash);

      const txStr = `tx-${i}-${uuidv4()}`;
      const txHashBytes = new TextEncoder().encode(txStr);
      const transactionHash = new DataHash(HashAlgorithm.SHA256, txHashBytes);

      const publicKey = new Uint8Array(32);
      const sigBytes = new Uint8Array(64);
      const signature = new Signature(sigBytes.slice(0, 63), sigBytes[63]);

      const authenticator = new Authenticator(publicKey, 'mock-algo', signature, stateHash);

      commitments.push(new Commitment(requestId, transactionHash, authenticator));
    }

    return commitments;
  }

  function createInstrumentedRoundManager(): RoundManager {
    const roundManager = new RoundManager(
      { chainId: 1, version: 1, forkId: 1 },
      mockAlphabillClient,
      smt,
      storage.blockStorage,
      storage.recordStorage,
      storage.commitmentStorage,
      storage.smtStorage,
    );

    const originalCreateBlock = roundManager.createBlock;
    roundManager.createBlock = async function () {
      const endPreparationPhase = metrics.startPhase('preparation');

      const getCommitmentsEnd = metrics.startPhase('getCommitments');
      const commitments = await this.commitmentStorage.getAll();
      getCommitmentsEnd();

      const aggregatorRecords: AggregatorRecord[] = [];
      const smtLeaves: SmtNode[] = [];

      for (const commitment of commitments) {
        aggregatorRecords.push(
          new AggregatorRecord(commitment.requestId, commitment.transactionHash, commitment.authenticator),
        );

        const nodePath = commitment.requestId.toBigInt();
        const nodeValue = commitment.transactionHash.data;
        smtLeaves.push(new SmtNode(nodePath, nodeValue));
      }

      const prepStart = performance.now();
      const recordStorageStart = performance.now();

      const recordStoragePromise =
        aggregatorRecords.length > 0 ? this.recordStorage.putBatch(aggregatorRecords) : Promise.resolve(true);

      const smtLeafStorageStart = performance.now();
      const smtLeafStoragePromise = smtLeaves.length > 0 ? this.smtStorage.putBatch(smtLeaves) : Promise.resolve(true);

      let totalSmtTime = 0;
      for (const leaf of smtLeaves) {
        const smtStart = performance.now();
        await this.smt.addLeaf(leaf.path, leaf.value);
        totalSmtTime += performance.now() - smtStart;
      }

      await recordStoragePromise;
      const totalRecordStorageTime = performance.now() - recordStorageStart;

      await smtLeafStoragePromise;
      const totalSmtLeafStorageTime = performance.now() - smtLeafStorageStart;

      const totalPrepTime = performance.now() - prepStart;
      const sequentialTime = totalSmtTime + totalRecordStorageTime + totalSmtLeafStorageTime;
      const parallelSavings = sequentialTime - totalPrepTime > 0 ? sequentialTime - totalPrepTime : 0;

      metrics.storeMetric('smtOperations', totalSmtTime);
      metrics.storeMetric('recordStorage', totalRecordStorageTime);
      metrics.storeMetric('smtLeafStorage', totalSmtLeafStorageTime);

      const rootHash = this.smt.rootHash;
      endPreparationPhase();

      const submitHashResponse = await this.alphabillClient.submitHash(rootHash);

      const endDbPhase = metrics.startPhase('blockFinalization');
      const txProof = submitHashResponse.txProof;
      const previousBlockHash = submitHashResponse.previousBlockHash;
      const blockNumber = await this.blockStorage.getNextBlockNumber();
      const block = new Block(
        blockNumber,
        this.config.chainId!,
        this.config.version!,
        this.config.forkId!,
        txProof.transactionProof.unicityCertificate.unicitySeal.timestamp,
        txProof,
        previousBlockHash,
        rootHash,
        null,
      );
      await this.blockStorage.put(block);
      endDbPhase();

      return block;
    };

    return roundManager;
  }

  async function runBenchmark(commitmentCount: number): Promise<BenchmarkResult> {
    const roundManager = createInstrumentedRoundManager();
    const commitments = await generateCommitments(commitmentCount);

    for (const commitment of commitments) {
      await roundManager.submitCommitment(commitment);
    }

    metrics.startBenchmark();
    const block = await roundManager.createBlock();
    const result = metrics.getBenchmarkResult(commitmentCount);

    return result;
  }

  async function formatResult(result: BenchmarkResult): Promise<void> {
    logger.info('\n----- Benchmark Results -----');
    logger.info(`Number of commitments: ${result.numCommitments}`);
    logger.info(`Total time: ${result.totalTimeMs.toFixed(2)}ms`);

    logger.info('\nPhase breakdown:');
    logger.info(
      `- Preparation:  ${result.phases.preparation.toFixed(2)}ms (${((result.phases.preparation * 100) / result.totalTimeMs).toFixed(2)}%)`,
    );
    logger.info(
      `- Submit hash:  ${result.phases.submitHash.toFixed(2)}ms (${((result.phases.submitHash * 100) / result.totalTimeMs).toFixed(2)}%)`,
    );
    logger.info(
      `- Block Finalization: ${result.phases.blockFinalization.toFixed(2)}ms (${((result.phases.blockFinalization * 100) / result.totalTimeMs).toFixed(2)}%)`,
    );

    if (result.phases.preparationDetails) {
      const pd = result.phases.preparationDetails;
      logger.info('\nPreparation phase details:');
      logger.info(
        `- Get commitments: ${pd.getCommitments.toFixed(2)}ms (${((pd.getCommitments * 100) / result.phases.preparation).toFixed(2)}% of prep)`,
      );
      logger.info(
        `- SMT operations: ${pd.smtOperations.toFixed(2)}ms (${((pd.smtOperations * 100) / result.phases.preparation).toFixed(2)}% of prep)`,
      );
      logger.info(
        `- Record storage: ${pd.recordStorage.toFixed(2)}ms (${((pd.recordStorage * 100) / result.phases.preparation).toFixed(2)}% of prep)`,
      );
      logger.info(
        `- SMT leaf storage: ${pd.smtLeafStorage.toFixed(2)}ms (${((pd.smtLeafStorage * 100) / result.phases.preparation).toFixed(2)}% of prep)`,
      );
    }

    logger.info('---------------------------\n');
  }

  test('Benchmark with 10 commitments', async () => {
    const result = await runBenchmark(10);
    await formatResult(result);
    expect(result.totalTimeMs).toBeGreaterThan(0);
  });

  test('Benchmark with 100 commitments', async () => {
    const result = await runBenchmark(100);
    await formatResult(result);
    expect(result.totalTimeMs).toBeGreaterThan(0);
  });

  test('Benchmark with 1,000 commitments', async () => {
    const result = await runBenchmark(1000);
    await formatResult(result);
    expect(result.totalTimeMs).toBeGreaterThan(0);
  });
});
