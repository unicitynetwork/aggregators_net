import { Authenticator } from '@unicitylabs/commons/lib/api/Authenticator.js';
import { InclusionProof } from '@unicitylabs/commons/lib/api/InclusionProof.js';
import { RequestId } from '@unicitylabs/commons/lib/api/RequestId.js';
import { SubmitStateTransitionStatus } from '@unicitylabs/commons/lib/api/SubmitStateTransitionStatus.js';
import { DataHasher } from '@unicitylabs/commons/lib/hash/DataHasher.js';
import { HashAlgorithm } from '@unicitylabs/commons/lib/hash/HashAlgorithm.js';
import { SigningService } from '@unicitylabs/commons/lib/signing/SigningService.js';
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
    payload: Uint8Array,
    authenticator: Authenticator,
  ): Promise<SubmitStateTransitionResponse> {
    const existingRecord = await this.recordStorage.get(requestId);
    if (existingRecord != null) {
      if (existingRecord.rootHash == payload) {
        console.log(`Record with ID ${requestId} already exists.`);
        const merkleTreePath = this.smt.getPath(requestId.toBigInt());
        return new SubmitStateTransitionResponse(
          new InclusionProof(merkleTreePath, existingRecord.authenticator, existingRecord.rootHash),
          SubmitStateTransitionStatus.SUCCESS,
        );
      }
      throw new Error('Request ID already exists with different payload.');
    }

    if (!(await this.verifyAuthenticator(requestId, payload, authenticator))) {
      throw new Error('Invalid authenticator.');
    }

    const submitHashResponse = await this.alphabillClient.submitHash(payload);
    const txProof = submitHashResponse.txProof;
    const previousBlockData = submitHashResponse.previousBlockData;
    const record = new AggregatorRecord(payload, previousBlockData, authenticator, txProof);
    await this.recordStorage.put(requestId, record);

    const leaf = new SmtNode(requestId.toBigInt(), payload);
    await this.smt.addLeaf(leaf.path, leaf.value);

    const newRootHash = this.smt.rootHash;
    console.log(`Request with ID ${requestId} registered, new root hash %s`, newRootHash.toString());
    const merkleTreePath = this.smt.getPath(requestId.toBigInt());
    return new SubmitStateTransitionResponse(
      new InclusionProof(merkleTreePath, record.authenticator, newRootHash),
      SubmitStateTransitionStatus.SUCCESS,
    );
  }

  public async getInclusionProof(requestId: RequestId): Promise<InclusionProof> {
    const record = await this.recordStorage.get(requestId);
    if (!record) {
      throw new Error('Record not found by request ID ' + requestId.encode());
    }
    const merkleTreePath = this.smt.getPath(requestId.toBigInt());
    return new InclusionProof(merkleTreePath, record.authenticator, record.rootHash);
  }

  public getNodeletionProof(): Promise<void> {
    throw new Error('Not implemented.');
  }

  private async verifyAuthenticator(
    requestId: RequestId,
    transactionHash: Uint8Array,
    authenticator: Authenticator,
  ): Promise<boolean> {
    const publicKey = authenticator.publicKey;
    const expectedRequestId = await new DataHasher(HashAlgorithm.SHA256)
      .update(publicKey)
      .update(authenticator.stateHash)
      .digest();
    if (expectedRequestId !== requestId.encode()) {
      return false;
    }
    const payloadHash = await new DataHasher(HashAlgorithm.SHA256).update(transactionHash).digest();
    return await SigningService.verifyWithPublicKey(payloadHash, authenticator.signature, publicKey);
  }
}
