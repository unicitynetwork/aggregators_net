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
    try {
      await this.commitmentStorage.put(commitment);
      return true;
    } catch (error) {
      console.error('Failed to submit commitment:', error);
      return false;
    }
  }

  public async createBlock(): Promise<Block> {
    const commitments = await this.commitmentStorage.getAll();

    const aggregatorRecords: AggregatorRecord[] = [];
    if (commitments && commitments.length > 0) {
      for (const commitment of commitments) {
        aggregatorRecords.push(
          new AggregatorRecord(commitment.requestId, commitment.transactionHash, commitment.authenticator),
        );
      }
    }

    // Start storing records in parallel with adding leaves to SMT
    let recordStoragePromise: Promise<boolean>;
    try {
      recordStoragePromise =
        aggregatorRecords.length > 0 ? this.recordStorage.putBatch(aggregatorRecords) : Promise.resolve(true);
    } catch (error) {
      console.error('Failed to start record storage:', error);
      throw error;
    }

    if (commitments && commitments.length > 0) {
      for (const commitment of commitments) {
        try {
          const nodePath = commitment.requestId.toBigInt();
          const nodeValue = commitment.transactionHash.data;
          const leaf = new SmtNode(nodePath, nodeValue);
          await this.smt.addLeaf(leaf.path, leaf.value);
        } catch (error) {
          console.error('Failed to add leaf to SMT:', error);
          throw error;
        }
      }
    }

    try {
      await recordStoragePromise;
    } catch (error) {
      console.error('Failed to store records:', error);
      throw error;
    }

    let submitHashResponse;
    const rootHash = this.smt.rootHash;
    try {
      submitHashResponse = await this.alphabillClient.submitHash(rootHash);
    } catch (error) {
      console.error('Failed to submit hash to Alphabill:', error);
      throw error;
    }

    try {
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
    } catch (error) {
      console.error('Failed to create or store block:', error);
      throw error;
    }
  }
}
