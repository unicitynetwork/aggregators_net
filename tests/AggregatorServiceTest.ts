import { Authenticator } from '@unicitylabs/commons/lib/api/Authenticator.js';
import { RequestId } from '@unicitylabs/commons/lib/api/RequestId.js';
import { DataHash } from '@unicitylabs/commons/lib/hash/DataHash.js';
import { HashAlgorithm } from '@unicitylabs/commons/lib/hash/HashAlgorithm.js';
import { Signature } from '@unicitylabs/commons/lib/signing/Signature.js';
import { SparseMerkleTree } from '@unicitylabs/commons/lib/smt/SparseMerkleTree.js';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

import { AggregatorService } from '../src/AggregatorService.js';
import { Commitment } from '../src/commitment/Commitment.js';
import logger from '../src/logger.js';
import { MockAlphabillClient } from './consensus/alphabill/MockAlphabillClient.js';
import { CommitmentStorage } from '../src/commitment/CommitmentStorage.js';
import { AggregatorRecordStorage } from '../src/records/AggregatorRecordStorage.js';
import { RoundManager } from '../src/RoundManager.js';
import { SubmitCommitmentStatus } from '../src/SubmitCommitmentResponse.js';
import { BlockStorage } from '../src/hashchain/BlockStorage.js';
import { BlockRecordsStorage } from '../src/records/BlockRecordsStorage.js';

describe('AggregatorService Tests', () => {
  jest.setTimeout(30000);

  let mongoServer: MongoMemoryServer;
  let mongoUri: string;
  let aggregatorService: AggregatorService;
  let roundManager: RoundManager;
  let recordStorage: AggregatorRecordStorage;
  let commitmentStorage: CommitmentStorage;
  let blockStorage: BlockStorage;
  let blockRecordsStorage: BlockRecordsStorage;
  let smt: SparseMerkleTree;
  let alphabillClient: MockAlphabillClient;

  const createTestCommitment = async (id: number): Promise<Commitment> => {
    const stateHashBytes = new TextEncoder().encode(`state-${id}-test`);
    const stateHash = new DataHash(HashAlgorithm.SHA256, stateHashBytes);

    const publicKey = new Uint8Array(32);
    const requestId = await RequestId.create(publicKey, stateHash);

    const txHashBytes = new TextEncoder().encode(`tx-${id}-test`);
    const transactionHash = new DataHash(HashAlgorithm.SHA256, txHashBytes);

    const sigBytes = new Uint8Array(65);
    sigBytes[64] = 0;
    const signature = new Signature(sigBytes.slice(0, 64), sigBytes[64]);

    const authenticator = new Authenticator(publicKey, 'mock-algo', signature, stateHash);

    jest.spyOn(authenticator, 'verify').mockResolvedValue(true);

    return new Commitment(requestId, transactionHash, authenticator);
  };

  const createDifferentTxHashCommitment = async (originalCommitment: Commitment): Promise<Commitment> => {
    const requestId = originalCommitment.requestId;
    const authenticator = originalCommitment.authenticator;

    const txHashBytes = new TextEncoder().encode(`different-tx-hash`);
    const transactionHash = new DataHash(HashAlgorithm.SHA256, txHashBytes);

    return new Commitment(requestId, transactionHash, authenticator);
  };

  beforeAll(async () => {
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
    await mongoose.connection.dropDatabase();

    alphabillClient = new MockAlphabillClient();
    recordStorage = new AggregatorRecordStorage();
    commitmentStorage = new CommitmentStorage();
    blockStorage = new BlockStorage();
    blockRecordsStorage = new BlockRecordsStorage();

    smt = await SparseMerkleTree.create(HashAlgorithm.SHA256);

    roundManager = new RoundManager(
      {
        chainId: 1,
        version: 1,
        forkId: 1,
        port: 9876,
        initialBlockHash: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
      },
      alphabillClient,
      smt,
      {} as any,
      recordStorage,
      {} as any,
      commitmentStorage,
      {} as any,
    );

    aggregatorService = new AggregatorService(roundManager, smt, recordStorage, blockStorage, blockRecordsStorage);
  });

  it('should handle submitting a new commitment correctly', async () => {
    const submitCommitmentSpy = jest.spyOn(roundManager, 'submitCommitment');

    const commitment = await createTestCommitment(1);

    const result = await aggregatorService.submitCommitment(commitment);

    expect(result.status).toBe(SubmitCommitmentStatus.SUCCESS);
    expect(result.exists).toBe(false);

    expect(submitCommitmentSpy).toHaveBeenCalledTimes(1);
    expect(submitCommitmentSpy).toHaveBeenCalledWith(commitment);
  });

  it('should not submit a duplicate commitment to roundManager when record already exists with same hash', async () => {
    const submitCommitmentSpy = jest.spyOn(roundManager, 'submitCommitment');

    const commitment = await createTestCommitment(2);

    const result1 = await aggregatorService.submitCommitment(commitment);
    expect(result1.status).toBe(SubmitCommitmentStatus.SUCCESS);
    expect(result1.exists).toBe(false);
    expect(submitCommitmentSpy).toHaveBeenCalledTimes(1);

    // since round manager is not running, we add the record manually
    await recordStorage.put(commitment);

    submitCommitmentSpy.mockClear();

    const result2 = await aggregatorService.submitCommitment(commitment);
    expect(result2.status).toBe(SubmitCommitmentStatus.SUCCESS);
    expect(result2.exists).toBe(true);

    expect(submitCommitmentSpy).not.toHaveBeenCalled();
  });

  it('should reject a commitment with the same requestId but different transaction hash', async () => {
    const commitment1 = await createTestCommitment(3);
    const result1 = await aggregatorService.submitCommitment(commitment1);
    expect(result1.status).toBe(SubmitCommitmentStatus.SUCCESS);

    // since round manager is not running, we add the record manually
    await recordStorage.put(commitment1);

    const commitment2 = await createDifferentTxHashCommitment(commitment1);

    const result2 = await aggregatorService.submitCommitment(commitment2);
    expect(result2.status).toBe(SubmitCommitmentStatus.REQUEST_ID_EXISTS);
    expect(result2.exists).toBe(false);
  });

  it('should retrieve commitments for a block number', async () => {
    const mockBlockRecordsStorage = {
      get: jest.fn(),
    };

    Object.defineProperty(roundManager, 'getBlockRecordsStorage', {
      value: jest.fn().mockReturnValue(mockBlockRecordsStorage),
    });

    const commitments: Commitment[] = [];
    const requestIds: RequestId[] = [];

    for (let i = 0; i < 3; i++) {
      const commitment = await createTestCommitment(i);
      commitments.push(commitment);
      requestIds.push(commitment.requestId);

      await recordStorage.put(commitment);
    }

    mockBlockRecordsStorage.get.mockResolvedValue({
      blockNumber: 123n,
      requestIds: requestIds,
    });

    const getByRequestIdsSpy = jest.spyOn(recordStorage, 'getByRequestIds');

    const result = await aggregatorService.getCommitmentsByBlockNumber(123n);

    expect(mockBlockRecordsStorage.get).toHaveBeenCalledWith(123n);
    expect(getByRequestIdsSpy).toHaveBeenCalledWith(requestIds);
    expect(result).toHaveLength(3);

    for (const commitment of commitments) {
      const found = result!.find(
        (record) =>
          record.requestId.toBigInt() === commitment.requestId.toBigInt() &&
          record.transactionHash.equals(commitment.transactionHash),
      );
      expect(found).toBeDefined();
    }
  });

  it('should return null when block records are not found', async () => {
    const mockBlockRecordsStorage = {
      get: jest.fn().mockResolvedValue(null),
    };

    Object.defineProperty(roundManager, 'getBlockRecordsStorage', {
      value: jest.fn().mockReturnValue(mockBlockRecordsStorage),
    });

    const result = await aggregatorService.getCommitmentsByBlockNumber(999n);

    expect(mockBlockRecordsStorage.get).toHaveBeenCalledWith(999n);
    expect(result).toBeNull();
  });
});
