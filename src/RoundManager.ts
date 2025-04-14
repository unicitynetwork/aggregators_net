import { SparseMerkleTree } from '@unicitylabs/commons/lib/smt/SparseMerkleTree.js';

import { IAggregatorConfig } from './AggregatorGateway.js';
import { Commitment } from './commitment/Commitment.js';
import { ICommitmentStorage } from './commitment/ICommitmentStorage.js';
import { IAlphabillClient } from './consensus/alphabill/IAlphabillClient.js';
import { Block } from './hashchain/Block.js';
import { IBlockStorage } from './hashchain/IBlockStorage.js';
import logger from './logger.js';
import { AggregatorRecord } from './records/AggregatorRecord.js';
import { IAggregatorRecordStorage } from './records/IAggregatorRecordStorage.js';
import { ISmtStorage } from './smt/ISmtStorage.js';
import { SmtNode } from './smt/SmtNode.js';

export class RoundManager {
  private commitmentCounter: number = 0;

  public constructor(
    public readonly config: IAggregatorConfig,
    public readonly alphabillClient: IAlphabillClient,
    public readonly smt: SparseMerkleTree,
    public readonly blockStorage: IBlockStorage,
    public readonly recordStorage: IAggregatorRecordStorage,
    public readonly commitmentStorage: ICommitmentStorage,
    public readonly smtStorage: ISmtStorage,
  ) {}

  public async submitCommitment(commitment: Commitment): Promise<boolean> {
    try {
      await this.commitmentStorage.put(commitment);
      return true;
    } catch (error) {
      logger.error('Failed to submit commitment:', error);
      return false;
    }
  }

  public async createBlock(): Promise<Block> {
    const commitments = await this.commitmentStorage.getCommitmentsForBlock();
    const commitmentCount = commitments?.length || 0;

    const aggregatorRecords: AggregatorRecord[] = [];
    const smtLeaves: SmtNode[] = [];

    if (commitments && commitments.length > 0) {
      for (const commitment of commitments) {
        aggregatorRecords.push(
          new AggregatorRecord(commitment.requestId, commitment.transactionHash, commitment.authenticator),
        );

        const nodePath = commitment.requestId.toBigInt();
        const nodeValue = commitment.transactionHash.data;
        smtLeaves.push(new SmtNode(nodePath, nodeValue));
      }
    }

    // Start storing records and SMT leaves in parallel
    let recordStoragePromise: Promise<boolean>;
    let smtLeafStoragePromise: Promise<boolean>;

    try {
      recordStoragePromise =
        aggregatorRecords.length > 0 ? this.recordStorage.putBatch(aggregatorRecords) : Promise.resolve(true);

      smtLeafStoragePromise = smtLeaves.length > 0 ? this.smtStorage.putBatch(smtLeaves) : Promise.resolve(true);
    } catch (error) {
      logger.error('Failed to start storing records and SMT leaves:', error);
      throw error;
    }

    // Add leaves to the SMT tree
    if (smtLeaves.length > 0) {
      for (const leaf of smtLeaves) {
        try {
          await this.smt.addLeaf(leaf.path, leaf.value);
        } catch (error) {
          // Check if the error is "Cannot add leaf inside branch" which indicates
          // the leaf is already in the tree - this is not a fatal error
          if (error instanceof Error && error.message.includes('Cannot add leaf inside branch')) {
            logger.warn(`Leaf already exists in tree for path ${leaf.path} - skipping`);
          } else {
            logger.error('Failed to add leaf to SMT:', error);
            throw error;
          }
        }
      }
    }

    try {
      await Promise.all([recordStoragePromise, smtLeafStoragePromise]);
    } catch (error) {
      logger.error('Failed to store records and SMT leaves:', error);
      throw error;
    }

    let submitHashResponse;
    const rootHash = this.smt.rootHash;
    try {
      submitHashResponse = await this.alphabillClient.submitHash(rootHash);
    } catch (error) {
      logger.error('Failed to submit hash to Alphabill:', error);
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

      if (commitments && commitments.length > 0) {
        await this.commitmentStorage.confirmBlockProcessed();
        
        // Only increment the counter if we successfully processed the block
        this.commitmentCounter += commitmentCount;
      }

      logger.info(`Block ${blockNumber} created successfully with ${commitmentCount} commitments`);

      return block;
    } catch (error) {
      console.error('Failed to create block:', error);
      throw error;
    }
  }

  /**
   * Returns the total number of commitments processed so far
   */
  public getCommitmentCount(): number {
    return this.commitmentCounter;
  }
}
