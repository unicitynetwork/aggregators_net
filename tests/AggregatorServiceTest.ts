import { InclusionProof } from '@unicitylabs/commons/lib/api/InclusionProof.js';
import { RequestId } from '@unicitylabs/commons/lib/api/RequestId.js';
import { SubmitCommitmentStatus } from '@unicitylabs/commons/lib/api/SubmitCommitmentResponse.js';
import { DataHash } from '@unicitylabs/commons/lib/hash/DataHash.js';
import { DataHasherFactory } from '@unicitylabs/commons/lib/hash/DataHasherFactory.js';
import { HashAlgorithm } from '@unicitylabs/commons/lib/hash/HashAlgorithm.js';
import { NodeDataHasher } from '@unicitylabs/commons/lib/hash/NodeDataHasher.js';
import { SigningService } from '@unicitylabs/commons/lib/signing/SigningService.js';
import { SparseMerkleTree } from '@unicitylabs/commons/lib/smt/SparseMerkleTree.js';
import { HexConverter } from '@unicitylabs/commons/lib/util/HexConverter.js';

import { AggregatorService } from '../src/AggregatorService.js';
import { Commitment } from '../src/commitment/Commitment.js';
import logger from '../src/logger.js';
import { MockBftClient } from './consensus/bft/MockBftClient.js';
import { CommitmentStorage } from '../src/commitment/CommitmentStorage.js';
import { BlockStorage } from '../src/hashchain/BlockStorage.js';
import { AggregatorRecordStorage } from '../src/records/AggregatorRecordStorage.js';
import { BlockRecordsStorage } from '../src/records/BlockRecordsStorage.js';
import { RoundManager } from '../src/RoundManager.js';
import { Smt } from '../src/smt/Smt.js';
import { MockValidationService } from './mocks/MockValidationService.js';
import { IValidationService } from '../src/ValidationService.js';
import { createTestCommitment as createTestAggregatorRecord, connectToSharedMongo, disconnectFromSharedMongo, clearAllCollections } from './TestUtils.js';

describe('AggregatorService Tests', () => {
  jest.setTimeout(30000);

  let mongoUri: string;
  let aggregatorService: AggregatorService;
  let roundManager: RoundManager;
  let recordStorage: AggregatorRecordStorage;
  let commitmentStorage: CommitmentStorage;
  let blockStorage: BlockStorage;
  let blockRecordsStorage: BlockRecordsStorage;
  let smt: SparseMerkleTree;
  let bftClient: MockBftClient;
  let signingService: SigningService;
  let validationService: IValidationService;

  const createTestCommitment = async (id: number): Promise<Commitment> => {
    const aggregatorRecord = await createTestAggregatorRecord(id);
    return new Commitment(aggregatorRecord.requestId, aggregatorRecord.transactionHash, aggregatorRecord.authenticator);
  };

  const createDifferentTxHashCommitment = (originalCommitment: Commitment): Commitment => {
    const requestId = originalCommitment.requestId;
    const authenticator = originalCommitment.authenticator;

    const txHashBytes = new TextEncoder().encode(`different-tx-hash`);
    const transactionHash = new DataHash(HashAlgorithm.SHA256, txHashBytes);

    return new Commitment(requestId, transactionHash, authenticator);
  };

  beforeAll(async () => {
    mongoUri = await connectToSharedMongo();
  });

  afterAll(async () => {
    await disconnectFromSharedMongo();
  });

  beforeEach(async () => {
    bftClient = new MockBftClient();
    recordStorage = new AggregatorRecordStorage();
    commitmentStorage = new CommitmentStorage();
    blockStorage = new BlockStorage();
    blockRecordsStorage = await BlockRecordsStorage.create('test-server');

    smt = new SparseMerkleTree(new DataHasherFactory(HashAlgorithm.SHA256, NodeDataHasher));

    roundManager = new RoundManager(
      {
        chainId: 1,
        version: 1,
        forkId: 1,
        port: 9876,
        initialBlockHash: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
      },
      bftClient,
      new Smt(smt),
      {} as never,
      recordStorage,
      {} as never,
      commitmentStorage,
      {} as never,
    );

    const privateKey = SigningService.generatePrivateKey();
    signingService = await SigningService.createFromSecret(privateKey);

    validationService = new MockValidationService();
    await validationService.initialize(mongoUri);
    
    aggregatorService = new AggregatorService(
      roundManager,
      new Smt(smt),
      recordStorage,
      blockStorage,
      blockRecordsStorage,
      signingService,
      validationService,
    );
  });

  afterEach(async () => {
    await clearAllCollections();

    // Ensure proper cleanup of change streams and other resources
    if (blockRecordsStorage) {
      try {
        await blockRecordsStorage.cleanup();
      } catch (error) {
        logger.warn('Error during blockRecordsStorage cleanup:', error);
        throw error; // Re-throw the error to fail the test
      }
    }
  });

  it('should handle submitting a new commitment correctly', async () => {
    const submitCommitmentSpy = jest.spyOn(roundManager, 'submitCommitment');

    const commitment = await createTestCommitment(1);

    const result = await aggregatorService.submitCommitment(commitment, true);

    expect(result.status).toBe(SubmitCommitmentStatus.SUCCESS);
    expect(result.receipt).toBeDefined();

    const receipt = result.receipt!;
    expect(receipt.signature).toBeDefined();
    expect(receipt.request).toBeDefined();
    
    const requestHash = receipt.request.hash;
    const signatureValid = await signingService.verify(requestHash, receipt.signature);
    expect(signatureValid).toBe(true);
    
    expect(receipt.publicKey).toBe(HexConverter.encode(signingService.publicKey));
    expect(receipt.algorithm).toBe(signingService.algorithm);

    expect(submitCommitmentSpy).toHaveBeenCalledTimes(1);
    expect(submitCommitmentSpy).toHaveBeenCalledWith(commitment);
  });

  it('should not submit a duplicate commitment to roundManager when record already exists with same hash', async () => {
    const submitCommitmentSpy = jest.spyOn(roundManager, 'submitCommitment');

    const commitment = await createTestCommitment(2);

    const result1 = await aggregatorService.submitCommitment(commitment);
    expect(result1.status).toBe(SubmitCommitmentStatus.SUCCESS);
    expect(submitCommitmentSpy).toHaveBeenCalledTimes(1);

    await recordStorage.put(commitment);
    submitCommitmentSpy.mockClear();

    const result2 = await aggregatorService.submitCommitment(commitment);
    expect(result2.status).toBe(SubmitCommitmentStatus.SUCCESS);

    expect(submitCommitmentSpy).not.toHaveBeenCalled();
  });

  it('should reject a commitment with the same requestId but different transaction hash', async () => {
    const commitment1 = await createTestCommitment(3);
    const result1 = await aggregatorService.submitCommitment(commitment1);
    expect(result1.status).toBe(SubmitCommitmentStatus.SUCCESS);

    await recordStorage.put(commitment1);

    const commitment2 = createDifferentTxHashCommitment(commitment1);

    const result2 = await aggregatorService.submitCommitment(commitment2);
    expect(result2.status).toBe(SubmitCommitmentStatus.REQUEST_ID_EXISTS);
  });

  it('should retrieve commitments for a block number', async () => {
    const requestIds: RequestId[] = [];
    const commitments: Commitment[] = [];

    for (let i = 0; i < 3; i++) {
      const commitment = await createTestCommitment(i);
      commitments.push(commitment);
      requestIds.push(commitment.requestId);

      await recordStorage.put(commitment);
    }

    jest.spyOn(blockRecordsStorage, 'get').mockResolvedValue({
      blockNumber: 123n,
      requestIds: requestIds,
    });

    const getByRequestIdsSpy = jest.spyOn(recordStorage, 'getByRequestIds');

    const result = await aggregatorService.getCommitmentsByBlockNumber(123n);

    expect(blockRecordsStorage.get).toHaveBeenCalledWith(123n);
    expect(getByRequestIdsSpy).toHaveBeenCalledWith(requestIds);
    expect(result).toHaveLength(3);

    for (const commitment of commitments) {
      const found = result!.find(
        (record) =>
          record.requestId.toBitString().toBigInt() === commitment.requestId.toBitString().toBigInt() &&
          record.transactionHash.equals(commitment.transactionHash),
      );
      expect(found).toBeDefined();
    }
  });

  it('should return null when block records are not found', async () => {
    jest.spyOn(blockRecordsStorage, 'get').mockResolvedValue(null);

    const result = await aggregatorService.getCommitmentsByBlockNumber(999n);

    expect(blockRecordsStorage.get).toHaveBeenCalledWith(999n);
    expect(result).toBeNull();
  });

  it('should return inclusion proof with PATH_NOT_INCLUDED status for non-existent requestId', async () => {
    const existingCommitment = await createTestCommitment(1);
    await recordStorage.put(existingCommitment);
    smt.addLeaf(existingCommitment.requestId.toBitString().toBigInt(), existingCommitment.transactionHash.imprint);

    const nonExistentStateHash = new DataHash(HashAlgorithm.SHA256, new TextEncoder().encode('non-existent-state'));
    const nonExistentRequestId = await RequestId.create(new Uint8Array(32), nonExistentStateHash);

    const inclusionProof = await aggregatorService.getInclusionProof(nonExistentRequestId);

    expect(inclusionProof).not.toBeNull();
    expect(inclusionProof).toBeInstanceOf(InclusionProof);
    expect(inclusionProof.authenticator).toBeNull();
    expect(inclusionProof.transactionHash).toBeNull();
    expect(inclusionProof.merkleTreePath).toBeDefined();

    const verificationResult = await inclusionProof.verify(nonExistentRequestId);
    expect(verificationResult).toBe('PATH_NOT_INCLUDED');
  });

  it('should return inclusion proof with PATH_NOT_INCLUDED status when record exists but path not in SMT', async () => {
    const commitment = await createTestCommitment(1);
    await recordStorage.put(commitment);

    const inclusionProof = await aggregatorService.getInclusionProof(commitment.requestId);

    expect(inclusionProof).not.toBeNull();
    expect(inclusionProof).toBeInstanceOf(InclusionProof);
    expect(inclusionProof.transactionHash).not.toBeNull();
    expect(inclusionProof.transactionHash!.equals(commitment.transactionHash)).toBeTruthy();
    expect(inclusionProof.merkleTreePath).toBeDefined();

    jest.spyOn(inclusionProof.authenticator!, 'verify').mockResolvedValue(true);

    const verificationResult = await inclusionProof.verify(commitment.requestId);
    expect(verificationResult).toBe('PATH_NOT_INCLUDED');
  });
});
