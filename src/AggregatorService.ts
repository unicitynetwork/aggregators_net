import { InclusionProof } from '@unicitylabs/commons/lib/api/InclusionProof.js';
import { RequestId } from '@unicitylabs/commons/lib/api/RequestId.js';
import { SparseMerkleTree } from '@unicitylabs/commons/lib/smt/SparseMerkleTree.js';

import { Commitment } from './commitment/Commitment.js';
import { Block } from './hashchain/Block.js';
import { IBlockStorage } from './hashchain/IBlockStorage.js';
import { AggregatorRecord } from './records/AggregatorRecord.js';
import { IAggregatorRecordStorage } from './records/IAggregatorRecordStorage.js';
import { IBlockRecordsStorage } from './records/IBlockRecordsStorage.js';
import { RoundManager } from './RoundManager.js';
import { SubmitCommitmentResponse, SubmitCommitmentStatus } from './SubmitCommitmentResponse.js';

export class AggregatorService {
  public constructor(
    public readonly roundManager: RoundManager,
    public readonly smt: SparseMerkleTree,
    public readonly recordStorage: IAggregatorRecordStorage,
    public readonly blockStorage: IBlockStorage,
    public readonly blockRecordsStorage: IBlockRecordsStorage,
  ) {}

  public async submitCommitment(commitment: Commitment): Promise<SubmitCommitmentResponse> {
    const validationResult = await this.validateCommitment(commitment);
    if (validationResult.status === SubmitCommitmentStatus.SUCCESS && !validationResult.exists) {
      await this.roundManager.submitCommitment(commitment);
    }
    return validationResult;
  }

  public async getInclusionProof(requestId: RequestId): Promise<InclusionProof | null> {
    const record = await this.recordStorage.get(requestId);
    if (!record) {
      return null;
    }
    const merkleTreePath = this.smt.getPath(requestId.toBigInt());
    return new InclusionProof(merkleTreePath, record.authenticator, record.transactionHash);
  }

  public getNodeletionProof(): Promise<void> {
    throw new Error('Not implemented.');
  }

  /**
   * Get the current block number
   * @returns The current block number as a bigint
   */
  public async getCurrentBlockNumber(): Promise<bigint> {
    return (await this.blockStorage.getNextBlockNumber()) - 1n;
  }

  /**
   * Get block information by block number
   * @param blockNumber The block number to retrieve
   * @returns Block or null if not found
   */
  public async getBlockByNumber(blockNumber: bigint): Promise<Block | null> {
    return await this.blockStorage.get(blockNumber);
  }

  /**
   * Get commitments for a specific block number
   * @param blockNumber The block number to retrieve commitments for
   * @returns Array of AggregatorRecord or null if block not found
   */
  public async getCommitmentsByBlockNumber(blockNumber: bigint): Promise<AggregatorRecord[] | null> {
    const blockRecords = await this.blockRecordsStorage.get(blockNumber);
    if (!blockRecords) {
      return null;
    }

    return await this.recordStorage.getByRequestIds(blockRecords.requestIds);
  }

  private async validateCommitment(commitment: Commitment): Promise<SubmitCommitmentResponse> {
    const { authenticator, requestId, transactionHash } = commitment;
    const expectedRequestId = await RequestId.create(authenticator.publicKey, authenticator.stateHash);
    if (!expectedRequestId.hash.equals(requestId.hash)) {
      return new SubmitCommitmentResponse(SubmitCommitmentStatus.REQUEST_ID_MISMATCH);
    }
    if (!(await authenticator.verify(transactionHash))) {
      return new SubmitCommitmentResponse(SubmitCommitmentStatus.AUTHENTICATOR_VERIFICATION_FAILED);
    }
    const existingRecord = await this.recordStorage.get(requestId);
    if (existingRecord) {
      if (!existingRecord.transactionHash.equals(transactionHash)) {
        return new SubmitCommitmentResponse(SubmitCommitmentStatus.REQUEST_ID_EXISTS);
      } else {
        const response = new SubmitCommitmentResponse(SubmitCommitmentStatus.SUCCESS);
        response.exists = true;
        return response;
      }
    }
    return new SubmitCommitmentResponse(SubmitCommitmentStatus.SUCCESS);
  }
}
