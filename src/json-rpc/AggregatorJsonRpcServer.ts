import { Authenticator } from '@unicitylabs/commons/lib/api/Authenticator';
import { InclusionProof } from '@unicitylabs/commons/lib/api/InclusionProof';
import { RequestId } from '@unicitylabs/commons/lib/api/RequestId';
import { SubmitStateTransitionStatus } from '@unicitylabs/commons/lib/api/SubmitStateTransitionStatus';
import { DataHasher, HashAlgorithm } from '@unicitylabs/commons/lib/hash/DataHasher';
import { SigningService } from '@unicitylabs/commons/lib/signing/SigningService';
import { SparseMerkleTree } from '@unicitylabs/commons/lib/smt/SparseMerkleTree';
import { JSONRPCServer } from 'json-rpc-2.0';

import { SubmitStateTransitionResponse } from './SubmitStateTransitionResponse.js';
import { AlphabillClient } from '../alphabill/AlphabillClient.js';
import { AggregatorRecord } from '../records/AggregatorRecord.js';
import { IAggregatorRecordStorage } from '../records/IAggregatorRecordStorage.js';
import { SmtNode } from '../smt/SmtNode.js';

export class AggregatorJsonRpcServer extends JSONRPCServer {
  public constructor(
    public readonly alphabillClient: AlphabillClient,
    public readonly smt: SparseMerkleTree,
    public readonly recordStorage: IAggregatorRecordStorage,
  ) {
    super();
    this.addMethod('aggregator_submit', () => this.submitStateTransition);
    this.addMethod('aggregator_get_path', this.getInclusionProof);
    this.addMethod('aggregator_get_nodel', this.getNodeletionProof);
  }

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

    const newRootHash = this.smt.rootHash();
    console.log(`Request with ID ${requestId} registered, new root hash %s`, newRootHash.toString());
    const merkleTreePath = this.smt.getPath(requestId.toBigInt());
    return new SubmitStateTransitionResponse(
      new InclusionProof(merkleTreePath, record.authenticator, newRootHash),
      SubmitStateTransitionStatus.SUCCESS,
    );
  }

  public async getInclusionProof(requestId: RequestId): Promise<InclusionProof> {
    const record = await this.recordStorage.get(requestId);
    const merkleTreePath = this.smt.getPath(requestId.toBigInt());
    return new InclusionProof(merkleTreePath, record.authenticator, record.rootHash);
  }

  public getNodeletionProof(): Promise<void> {
    throw new Error('Not implemented.');
  }

  private async verifyAuthenticator(
    requestId: RequestId,
    payload: Uint8Array,
    authenticator: Authenticator,
  ): Promise<boolean> {
    const publicKey = authenticator.publicKey;
    const expectedRequestId = await new DataHasher(HashAlgorithm.SHA256)
      .update(publicKey)
      .update(authenticator.state)
      .digest();
    if (expectedRequestId !== requestId.encode()) {
      return false;
    }
    const payloadHash = await new DataHasher(HashAlgorithm.SHA256).update(payload).digest();
    return await SigningService.verifyWithPublicKey(payloadHash, authenticator.signature, publicKey);
  }
}
