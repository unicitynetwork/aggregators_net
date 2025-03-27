import { Authenticator } from '@unicitylabs/commons/lib/api/Authenticator.js';
import { IInclusionProofDto, InclusionProof } from '@unicitylabs/commons/lib/api/InclusionProof.js';
import { ISubmitStateTransitionResponseDto } from '@unicitylabs/commons/lib/api/ISubmitStateTransitionResponseDto.js';
import { RequestId } from '@unicitylabs/commons/lib/api/RequestId.js';
import { SubmitStateTransitionStatus } from '@unicitylabs/commons/lib/api/SubmitStateTransitionStatus.js';
import { DataHash } from '@unicitylabs/commons/lib/hash/DataHash.js';
import { SparseMerkleTree } from '@unicitylabs/commons/lib/smt/SparseMerkleTree.js';

import { IAlphabillClient } from './alphabill/IAlphabillClient.js';
import { AggregatorRecord } from './records/AggregatorRecord.js';
import { IAggregatorRecordStorage } from './records/IAggregatorRecordStorage.js';
import { SmtNode } from './smt/SmtNode.js';
import { SubmitStateTransitionResponse } from './SubmitStateTransitionResponse.js';
export class AggregatorService {
  public constructor(
    public readonly alphabillClient: IAlphabillClient,
    public readonly smt: SparseMerkleTree,
    public readonly recordStorage: IAggregatorRecordStorage,
  ) {}

  public async submitStateTransition(
    requestId: RequestId,
    transactionHash: DataHash,
    authenticator: Authenticator,
  ): Promise<ISubmitStateTransitionResponseDto> {
    const existingRecord = await this.recordStorage.get(requestId);
    if (existingRecord != null) {
      if (existingRecord.rootHash.equals(transactionHash)) {
        console.log(`Record with ID ${requestId} already exists.`);
        const merkleTreePath = this.smt.getPath(requestId.toBigInt());
        return new SubmitStateTransitionResponse(
          new InclusionProof(merkleTreePath, existingRecord.authenticator, existingRecord.rootHash),
          SubmitStateTransitionStatus.SUCCESS,
        ).toDto();
      }
      throw new Error('Request ID already exists with different transaction hash.');
    }

    if (!authenticator.verify(transactionHash)) {
      throw new Error('Authenticator verification failed.');
    }

    const submitHashResponse = await this.alphabillClient.submitHash(transactionHash);
    const txProof = submitHashResponse.txProof;
    const previousBlockData = submitHashResponse.previousBlockData;
    const record = new AggregatorRecord(transactionHash, previousBlockData, authenticator, txProof);
    await this.recordStorage.put(requestId, record);

    const leaf = new SmtNode(requestId.toBigInt(), transactionHash.data);
    await this.smt.addLeaf(leaf.path, leaf.value);

    const newRootHash = this.smt.rootHash;
    console.log(`Request with ID ${requestId} registered, new root hash %s`, newRootHash.toString());
    const merkleTreePath = this.smt.getPath(requestId.toBigInt());
    return new SubmitStateTransitionResponse(
      new InclusionProof(merkleTreePath, record.authenticator, newRootHash),
      SubmitStateTransitionStatus.SUCCESS,
    ).toDto();
  }

  public async getInclusionProof(requestId: RequestId): Promise<IInclusionProofDto> {
    const record = await this.recordStorage.get(requestId);
    if (!record) {
      throw new Error('Record not found by request ID ' + requestId.toString());
    }
    const merkleTreePath = this.smt.getPath(requestId.toBigInt());
    return new InclusionProof(merkleTreePath, record.authenticator, record.rootHash).toDto();
  }

  public getNodeletionProof(): Promise<void> {
    throw new Error('Not implemented.');
  }
}
