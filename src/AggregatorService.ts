import { InclusionProof } from '@unicitylabs/commons/lib/api/InclusionProof.js';
import { RequestId } from '@unicitylabs/commons/lib/api/RequestId.js';
import { SparseMerkleTree } from '@unicitylabs/commons/lib/smt/SparseMerkleTree.js';
import { HexConverter } from '@unicitylabs/commons/lib/util/HexConverter.js';

import { Commitment } from './commitment/Commitment.js';
import { IAggregatorRecordStorage } from './records/IAggregatorRecordStorage.js';
import { RoundManager } from './RoundManager.js';
import { SubmitStateTransitionResponse, SubmitStateTransitionStatus } from './SubmitStateTransitionResponse.js';

export class AggregatorService {
  public constructor(
    public readonly roundManager: RoundManager,
    public readonly smt: SparseMerkleTree,
    public readonly recordStorage: IAggregatorRecordStorage,
  ) {}

  public async submitStateTransition(commitment: Commitment): Promise<SubmitStateTransitionResponse> {
    const { requestId, transactionHash, authenticator } = commitment;
    console.log(`Request with ID ${requestId} received.`);
    const existingRecord = await this.recordStorage.get(requestId);
    if (existingRecord) {
      if (
        HexConverter.encode(existingRecord.transactionHash.imprint) === HexConverter.encode(transactionHash.imprint)
      ) {
        console.log('Duplicate request received, skipping...');
        return new SubmitStateTransitionResponse(SubmitStateTransitionStatus.SUCCESS);
      }
      return new SubmitStateTransitionResponse(SubmitStateTransitionStatus.REQUEST_ID_EXISTS);
    }
    const expectedRequestId = await RequestId.create(authenticator.publicKey, authenticator.stateHash);
    if (!expectedRequestId.hash.equals(requestId.hash)) {
      return new SubmitStateTransitionResponse(SubmitStateTransitionStatus.REQUEST_ID_MISMATCH);
    }
    if (!(await authenticator.verify(transactionHash))) {
      return new SubmitStateTransitionResponse(SubmitStateTransitionStatus.AUTHENTICATOR_VERIFICATION_FAILED);
    }
    await this.roundManager.submitCommitment(commitment);
    console.log(`Request with ID ${requestId} successfully submitted to round.`);
    return new SubmitStateTransitionResponse(SubmitStateTransitionStatus.SUCCESS);
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
}
