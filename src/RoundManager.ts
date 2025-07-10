import { LeafValue } from '@unicitylabs/commons/lib/api/LeafValue.js';
import { HexConverter } from '@unicitylabs/commons/lib/util/HexConverter.js';

import { IAggregatorConfig } from './AggregatorGateway.js';
import { Commitment } from './commitment/Commitment.js';
import { ICommitmentStorage } from './commitment/ICommitmentStorage.js';
import { IBftClient } from './consensus/bft/IBftClient.js';
import { Block } from './hashchain/Block.js';
import { IBlockStorage } from './hashchain/IBlockStorage.js';
import logger from './logger.js';
import { AggregatorRecord } from './records/AggregatorRecord.js';
import { BlockRecords } from './records/BlockRecords.js';
import { IAggregatorRecordStorage } from './records/IAggregatorRecordStorage.js';
import { IBlockRecordsStorage } from './records/IBlockRecordsStorage.js';
import { ISmtStorage } from './smt/ISmtStorage.js';
import { Smt } from './smt/Smt.js';
import { SmtNode } from './smt/SmtNode.js';
import { withTransaction } from './transaction/TransactionUtils.js';

export class RoundManager {
  private commitmentCounter: number = 0;
  private submitCounter: number = 0;

  public constructor(
    public readonly config: IAggregatorConfig,
    public readonly bftClient: IBftClient,
    public readonly smt: Smt,
    public readonly blockStorage: IBlockStorage,
    public readonly recordStorage: IAggregatorRecordStorage,
    public readonly blockRecordsStorage: IBlockRecordsStorage,
    public readonly commitmentStorage: ICommitmentStorage,
    public readonly smtStorage: ISmtStorage,
  ) {}

  public async submitCommitment(commitment: Commitment): Promise<void> {
    const loggerWithMetadata = logger.child({ requestId: commitment.requestId.toString() });
    try {
      await this.commitmentStorage.put(commitment);
      this.submitCounter++;
    } catch (error) {
      loggerWithMetadata.error('Failed to submit commitment:', error);
      throw error;
    }
  }

  public async createBlock(): Promise<Block> {
    const blockNumber = await this.blockStorage.getNextBlockNumber();
    const commitments = await this.commitmentStorage.getCommitmentsForBlock();

    const commitmentCount = commitments?.length || 0;
    const loggerWithMetadata = logger.child({ blockNumber: blockNumber, commitmentsSize: commitmentCount });
    loggerWithMetadata.info(`Starting to create block ${blockNumber}...`);

    const aggregatorRecords: AggregatorRecord[] = [];
    const smtLeaves: SmtNode[] = [];

    if (commitments && commitments.length > 0) {
      for (const commitment of commitments) {
        aggregatorRecords.push(
          new AggregatorRecord(commitment.requestId, commitment.transactionHash, commitment.authenticator),
        );

        const nodePath = commitment.requestId.toBitString().toBigInt();
        const leafValue = await LeafValue.create(commitment.authenticator, commitment.transactionHash);
        smtLeaves.push(new SmtNode(nodePath, leafValue.bytes));
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
      loggerWithMetadata.error('Failed to start storing records and SMT leaves:', error);
      throw error;
    }

    // Add leaves to the SMT tree
    if (smtLeaves.length > 0) {
      await this.smt.addLeaves(smtLeaves);
    }

    try {
      await Promise.all([recordStoragePromise, smtLeafStoragePromise]);
    } catch (error) {
      loggerWithMetadata.error('Failed to store records and SMT leaves:', error);
      throw error;
    }

    let submitHashResponse;
    const rootHash = this.smt.rootHash;
    try {
      loggerWithMetadata.info(`Submitting hash to BFT: ${rootHash.toString()}...`);
      submitHashResponse = await this.bftClient.submitHash(rootHash);
      loggerWithMetadata.info(`Hash submitted to BFT: ${rootHash.toString()}`);
    } catch (error) {
      loggerWithMetadata.error('Failed to submit hash to BFT:', error);
      throw error;
    }

    try {
      const txProof = submitHashResponse.txProof;
      const previousBlockHash =
        blockNumber !== 1n ? submitHashResponse.previousBlockHash : HexConverter.decode(this.config.initialBlockHash!);
      const block = new Block(
        blockNumber,
        this.config.chainId!,
        this.config.version!,
        this.config.forkId!,
        txProof.transactionProof.unicityCertificate.unicitySeal.timestamp,
        txProof,
        previousBlockHash!,
        rootHash,
        null, // TODO add noDeletionProof
      );

      await withTransaction(async (session) => {
        await this.blockStorage.put(block, session);

        await this.blockRecordsStorage.put(
          new BlockRecords(
            blockNumber,
            commitments.map((commitment) => commitment.requestId),
          ),
          session,
        );

        if (commitments && commitments.length > 0) {
          await this.commitmentStorage.confirmBlockProcessed(session);
        }
      });

      // Only increment the counter if we successfully processed the block
      if (commitments && commitments.length > 0) {
        this.commitmentCounter += commitmentCount;
      }

      loggerWithMetadata.info(
        `Block ${blockNumber} created successfully with ${commitmentCount} commitments (${this.commitmentCounter} commitments processed by this node)`,
      );

      return block;
    } catch (error) {
      loggerWithMetadata.error('Failed to create block:', error);
      throw error;
    }
  }

  /**
   * Returns the total number of commitments processed so far
   */
  public getCommitmentCount(): number {
    return this.commitmentCounter;
  }

  /**
   * Exposes the Block Storage.
   */
  public getBlockStorage(): IBlockStorage {
    return this.blockStorage;
  }

  /**
   * Exposes the Block Records Storage.
   */
  public getBlockRecordsStorage(): IBlockRecordsStorage {
    return this.blockRecordsStorage;
  }

  /**
   * Exposes the Record Storage.
   */
  public getRecordStorage(): IAggregatorRecordStorage {
    return this.recordStorage;
  }
}
