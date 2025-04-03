import { Authenticator } from '@unicitylabs/commons/lib/api/Authenticator.js';
import { InclusionProof } from '@unicitylabs/commons/lib/api/InclusionProof.js';
import { RequestId } from '@unicitylabs/commons/lib/api/RequestId.js';
import { DataHash } from '@unicitylabs/commons/lib/hash/DataHash.js';
import { SparseMerkleTree } from '@unicitylabs/commons/lib/smt/SparseMerkleTree.js';

import { IAggregatorConfig } from './AggregatorGateway.js';
import { IAlphabillClient } from './alphabill/IAlphabillClient.js';
import { AggregatorRecord } from './records/AggregatorRecord.js';
import { IAggregatorRecordStorage } from './records/IAggregatorRecordStorage.js';
import { SmtNode } from './smt/SmtNode.js';
import { SubmitStateTransitionResponse, SubmitStateTransitionStatus } from './SubmitStateTransitionResponse.js';

export class AggregatorService {
  public constructor(
    public readonly config: IAggregatorConfig,
    public readonly alphabillClient: IAlphabillClient,
    public readonly smt: SparseMerkleTree,
    public readonly recordStorage: IAggregatorRecordStorage,
  ) {}

  public async submitStateTransition(
    requestId: RequestId,
    transactionHash: DataHash,
    authenticator: Authenticator,
  ): Promise<SubmitStateTransitionResponse> {
    const existingRecord = await this.recordStorage.get(requestId);
    if (existingRecord != null) {
      if (existingRecord.rootHash.equals(transactionHash)) {
        console.log(`Record with ID ${requestId} already exists.`);
        const merkleTreePath = this.smt.getPath(requestId.toBigInt());
        return new SubmitStateTransitionResponse(
          new InclusionProof(merkleTreePath, existingRecord.authenticator, existingRecord.rootHash),
          SubmitStateTransitionStatus.SUCCESS,
        );
      }
      return new SubmitStateTransitionResponse(null, SubmitStateTransitionStatus.REQUEST_ID_EXISTS);
    }

    if (!(await authenticator.verify(transactionHash))) {
      return new SubmitStateTransitionResponse(null, SubmitStateTransitionStatus.AUTHENTICATOR_VERIFICATION_FAILED);
    }

    const submitHashResponse = await this.alphabillClient.submitHash(transactionHash);
    const txProof = submitHashResponse.txProof;
    const previousBlockHash = submitHashResponse.previousBlockHash;
    const blockNumber = 1n; // TODO add block number
    const record = new AggregatorRecord(
      this.config.chainId!,
      this.config.version!,
      this.config.forkId!,
      blockNumber,
      txProof.transactionProof.unicityCertificate.unicitySeal.timestamp,
      txProof,
      previousBlockHash,
      transactionHash,
      null, // TODO add noDeletionProof
      authenticator,
    );
    await this.recordStorage.put(requestId, record);

    const leaf = new SmtNode(requestId.toBigInt(), transactionHash.data);
    await this.smt.addLeaf(leaf.path, leaf.value);

    const newRootHash = this.smt.rootHash;
    console.log(`Request with ID ${requestId} registered, new root hash %s`, newRootHash.toString());
    const merkleTreePath = this.smt.getPath(requestId.toBigInt());
    return new SubmitStateTransitionResponse(
      new InclusionProof(merkleTreePath, record.authenticator, newRootHash),
      SubmitStateTransitionStatus.SUCCESS,
    );
  }

  public async getInclusionProof(requestId: RequestId): Promise<InclusionProof | null> {
    const record = await this.recordStorage.get(requestId);
    if (!record) {
      return null;
    }
    const merkleTreePath = this.smt.getPath(requestId.toBigInt());
    return new InclusionProof(merkleTreePath, record.authenticator, record.rootHash);
  }

  public getNodeletionProof(): Promise<void> {
    throw new Error('Not implemented.');
  }
}
