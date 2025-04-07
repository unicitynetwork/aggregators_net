import { SparseMerkleTree } from '@unicitylabs/commons/lib/smt/SparseMerkleTree.js';

import { IAggregatorConfig } from './AggregatorGateway.js';
import { Commitment } from './commitment/Commitment.js';
import { ICommitmentStorage } from './commitment/ICommitmentStorage.js';
import { IAlphabillClient } from './consensus/alphabill/IAlphabillClient.js';
import { Block } from './hashchain/Block.js';
import { IBlockStorage } from './hashchain/IBlockStorage.js';
import { AggregatorRecord } from './records/AggregatorRecord.js';
import { IAggregatorRecordStorage } from './records/IAggregatorRecordStorage.js';
import { SmtNode } from './smt/SmtNode.js';

export class RoundManager {
  public constructor(
    public readonly config: IAggregatorConfig,
    public readonly alphabillClient: IAlphabillClient,
    public readonly smt: SparseMerkleTree,
    public readonly blockStorage: IBlockStorage,
    public readonly recordStorage: IAggregatorRecordStorage,
    public readonly commitmentStorage: ICommitmentStorage,
  ) {}

  public async submitCommitment(commitment: Commitment): Promise<boolean> {
    await this.commitmentStorage.put(commitment);
    return true;
  }

  public async createBlock(): Promise<Block> {
    const commitments = await this.commitmentStorage.getAll();
    for (const commitment of commitments) {
      const nodePath = commitment.requestId.toBigInt();
      const nodeValue = commitment.transactionHash.data;
      const leaf = new SmtNode(nodePath, nodeValue);
      await this.smt.addLeaf(leaf.path, leaf.value);
      await this.recordStorage.put(
        new AggregatorRecord(commitment.requestId, commitment.transactionHash, commitment.authenticator),
      );
    }
    const rootHash = this.smt.rootHash;
    const submitHashResponse = await this.alphabillClient.submitHash(rootHash);
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
      rootHash,
      null, // TODO add noDeletionProof
    );
    await this.blockStorage.put(block);
    return block;
  }
}
