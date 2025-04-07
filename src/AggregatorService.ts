import { InclusionProof } from '@unicitylabs/commons/lib/api/InclusionProof.js';
import { RequestId } from '@unicitylabs/commons/lib/api/RequestId.js';
import { SparseMerkleTree } from '@unicitylabs/commons/lib/smt/SparseMerkleTree.js';

import { Commitment } from './commitment/Commitment.js';
import { IAggregatorRecordStorage } from './records/IAggregatorRecordStorage.js';
import { RoundManager } from './RoundManager.js';
import { SubmitCommitmentResponse, SubmitCommitmentStatus } from './SubmitCommitmentResponse.js';

export class AggregatorService {
  public constructor(
    public readonly roundManager: RoundManager,
    public readonly smt: SparseMerkleTree,
    public readonly recordStorage: IAggregatorRecordStorage,
  ) {}

  public async submitCommitment(commitment: Commitment): Promise<SubmitCommitmentResponse> {
    const status = await this.validateCommitment(commitment);
    if (status.status === SubmitCommitmentStatus.SUCCESS) {
      await this.roundManager.submitCommitment(commitment);
    }
    return status;
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
    if (existingRecord && !existingRecord.transactionHash.equals(transactionHash)) {
      return new SubmitCommitmentResponse(SubmitCommitmentStatus.REQUEST_ID_EXISTS);
    }
    return new SubmitCommitmentResponse(SubmitCommitmentStatus.SUCCESS);
  }
}
