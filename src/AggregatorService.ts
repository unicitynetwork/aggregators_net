import { Authenticator } from '@unicitylabs/commons/lib/api/Authenticator.js';
import { InclusionProof } from '@unicitylabs/commons/lib/api/InclusionProof.js';
import { RequestId } from '@unicitylabs/commons/lib/api/RequestId.js';
import { DataHash } from '@unicitylabs/commons/lib/hash/DataHash.js';
import { SparseMerkleTree } from '@unicitylabs/commons/lib/smt/SparseMerkleTree.js';

import { IAggregatorConfig } from './AggregatorGateway.js';
import { IAlphabillClient } from './consensus/alphabill/IAlphabillClient.js';
import { Block } from './hashchain/Block.js';
import { IBlockStorage } from './hashchain/IBlockStorage.js';
import { SmtNode } from './smt/SmtNode.js';
import { SubmitStateTransitionResponse, SubmitStateTransitionStatus } from './SubmitStateTransitionResponse.js';

export class AggregatorService {
  public constructor(
    public readonly config: IAggregatorConfig,
    public readonly alphabillClient: IAlphabillClient,
    public readonly smt: SparseMerkleTree,
    public readonly blockStorage: IBlockStorage,
  ) {}

  public async submitStateTransition(
    requestId: RequestId,
    transactionHash: DataHash,
    authenticator: Authenticator,
  ): Promise<SubmitStateTransitionResponse> {
    const existingBlock = await this.blockStorage.get(requestId);
    if (existingBlock != null) {
      return new SubmitStateTransitionResponse(null, SubmitStateTransitionStatus.REQUEST_ID_EXISTS);
    }

    if (!(await authenticator.verify(transactionHash))) {
      return new SubmitStateTransitionResponse(null, SubmitStateTransitionStatus.AUTHENTICATOR_VERIFICATION_FAILED);
    }

    const submitHashResponse = await this.alphabillClient.submitHash(transactionHash);
    const txProof = submitHashResponse.txProof;
    const previousBlockHash = submitHashResponse.previousBlockHash;
    const blockNumber = await this.blockStorage.getNextBlockNumber();
    const block = new Block(
      blockNumber,
      this.config.chainId!,
      this.config.version!,
      this.config.forkId!,
      txProof.transactionProof.unicityCertificate.unicitySeal.timestamp,
      txProof,
      previousBlockHash,
      transactionHash,
      null, // TODO add noDeletionProof
      authenticator,
    );
    await this.blockStorage.put(requestId, block);

    const leaf = new SmtNode(requestId.toBigInt(), transactionHash.data);
    await this.smt.addLeaf(leaf.path, leaf.value);

    const newRootHash = this.smt.rootHash;
    console.log(`Request with ID ${requestId} registered, new root hash %s`, newRootHash.toString());
    const merkleTreePath = this.smt.getPath(requestId.toBigInt());
    return new SubmitStateTransitionResponse(
      new InclusionProof(merkleTreePath, block.authenticator, newRootHash),
      SubmitStateTransitionStatus.SUCCESS,
    );
  }

  public async getInclusionProof(requestId: RequestId): Promise<InclusionProof | null> {
    const block = await this.blockStorage.get(requestId);
    if (!block) {
      return null;
    }
    const merkleTreePath = this.smt.getPath(requestId.toBigInt());
    return new InclusionProof(merkleTreePath, block.authenticator, block.rootHash);
  }

  public getNodeletionProof(): Promise<void> {
    throw new Error('Not implemented.');
  }
}
