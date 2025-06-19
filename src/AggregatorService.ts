import { InclusionProof } from '@unicitylabs/commons/lib/api/InclusionProof.js';
import { RequestId } from '@unicitylabs/commons/lib/api/RequestId.js';
import { SubmitCommitmentResponse, SubmitCommitmentStatus } from '@unicitylabs/commons/lib/api/SubmitCommitmentResponse.js';
import { type ISigningService } from '@unicitylabs/commons/lib/signing/ISigningService.js';
import { Signature } from '@unicitylabs/commons/lib/signing/Signature.js';

import { Commitment } from './commitment/Commitment.js';
import { Block } from './hashchain/Block.js';
import { IBlockStorage } from './hashchain/IBlockStorage.js';
import { AggregatorRecord } from './records/AggregatorRecord.js';
import { IAggregatorRecordStorage } from './records/IAggregatorRecordStorage.js';
import { IBlockRecordsStorage } from './records/IBlockRecordsStorage.js';
import { RoundManager } from './RoundManager.js';
import { Smt } from './smt/Smt.js';
import { IValidationService } from './ValidationService.js';

export class AggregatorService {
  public constructor(
    public readonly roundManager: RoundManager,
    public readonly smt: Smt,
    public readonly recordStorage: IAggregatorRecordStorage,
    public readonly blockStorage: IBlockStorage,
    public readonly blockRecordsStorage: IBlockRecordsStorage,
    public readonly signingService: ISigningService<Signature>,
    private readonly validationService: IValidationService,
  ) {}

  public async submitCommitment(commitment: Commitment, receipt: boolean = false): Promise<SubmitCommitmentResponse> {
    const validationResult = await this.validationService.validateCommitment(commitment);
    
    if (validationResult.status === SubmitCommitmentStatus.SUCCESS && !validationResult.exists) {
      await this.roundManager.submitCommitment(commitment);
    }
    
    if (validationResult.status === SubmitCommitmentStatus.SUCCESS && receipt) {
      const response = new SubmitCommitmentResponse(validationResult.status);
      await response.addSignedReceipt(commitment.requestId, commitment.authenticator.stateHash, commitment.transactionHash, this.signingService);
      return response;
    }
    return new SubmitCommitmentResponse(validationResult.status);
  }

  public async getInclusionProof(requestId: RequestId): Promise<InclusionProof> {
    const record = await this.recordStorage.get(requestId);
    const merkleTreePath = await this.smt.getPath(requestId.toBigInt());

    if (!record) {
      return new InclusionProof(merkleTreePath, null, null);
    }

    return new InclusionProof(merkleTreePath, record.authenticator, record.transactionHash);
  }

  public getNoDeletionProof(): Promise<void> {
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
   * Get the SMT instance
   * @returns The Smt instance
   */
  public getSmt(): Smt {
    return this.smt;
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
}
