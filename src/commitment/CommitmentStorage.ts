import { Authenticator } from '@unicitylabs/commons/lib/api/Authenticator.js';
import { RequestId } from '@unicitylabs/commons/lib/api/RequestId.js';
import { DataHash } from '@unicitylabs/commons/lib/hash/DataHash.js';
import { Signature } from '@unicitylabs/commons/lib/signing/Signature.js';
import mongoose, { model } from 'mongoose';

import { SCHEMA_TYPES } from '../StorageSchemaTypes.js';
import { Commitment } from './Commitment.js';
import { ICommitmentStorage } from './ICommitmentStorage.js';
import logger from '../logger.js';

interface ICommitment {
  requestId: string;
  transactionHash: Uint8Array;
  authenticator: {
    publicKey: Uint8Array;
    algorithm: string;
    signature: Uint8Array;
    stateHash: Uint8Array;
  };
  sequenceId: number;
}

enum CursorStatus {
  COMPLETE = 'COMPLETE',
  IN_PROGRESS = 'IN_PROGRESS',
}

const COMMITMENT_BATCH_SIZE = 1000;

interface ICursorCheckpoint {
  // Status of the cursor
  status: string;
  // Sequence IDs for tracking processed commitments
  lastProcessedSequenceId: number;
  currentBatchEndSequenceId: number;
}

const CommitmentSchema = new mongoose.Schema(
  {
    requestId: { required: true, type: String, unique: true },
    transactionHash: { required: true, type: SCHEMA_TYPES.UINT8_ARRAY },
    authenticator: {
      algorithm: { required: true, type: String },
      publicKey: { required: true, type: SCHEMA_TYPES.UINT8_ARRAY },
      signature: { required: true, type: SCHEMA_TYPES.UINT8_ARRAY },
      stateHash: { required: true, type: SCHEMA_TYPES.UINT8_ARRAY },
    },
    sequenceId: { required: true, type: Number, index: true },
  },
  {
    capped: {
      size: 10 * 1024 * 1024,
    },
  },
);

const CursorCheckpointSchema = new mongoose.Schema(
  {
    _id: { type: String, default: 'commitmentCursor' },
    status: {
      type: String,
      enum: [CursorStatus.COMPLETE, CursorStatus.IN_PROGRESS],
      default: CursorStatus.COMPLETE,
    },
    lastProcessedSequenceId: { type: Number },
    currentBatchEndSequenceId: { type: Number },
  },
  {
    timestamps: true,
  },
);

const CommitmentModel = model<ICommitment>('Commitment', CommitmentSchema);
const CursorCheckpointModel = model<ICursorCheckpoint>('CursorCheckpoint', CursorCheckpointSchema);

const sequenceSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  seq: { type: Number, default: 0 },
});

const SequenceModel = mongoose.model('Sequence', sequenceSchema);

async function getNextSequenceValue(sequenceName: string): Promise<number> {
  const sequenceDoc = await SequenceModel.findOneAndUpdate(
    { _id: sequenceName },
    { $inc: { seq: 1 } },
    { new: true, upsert: true },
  );
  return sequenceDoc.seq;
}

export class CommitmentStorage implements ICommitmentStorage {
  private readonly retryAttempts = 5;
  private readonly retryDelay = 100; // ms

  public async put(commitment: Commitment): Promise<boolean> {
    try {
      const sequenceId = await getNextSequenceValue('commitment_counter');
      const commitmentData = {
        requestId: commitment.requestId.toJSON(),
        transactionHash: commitment.transactionHash.imprint,
        authenticator: {
          algorithm: commitment.authenticator.algorithm,
          publicKey: commitment.authenticator.publicKey,
          signature: commitment.authenticator.signature.encode(),
          stateHash: commitment.authenticator.stateHash.imprint,
        },
        sequenceId,
      };

      let retries = 0;
      let success = false;
      while (!success && retries < this.retryAttempts) {
        try {
          await CommitmentModel.create(commitmentData);
          success = true;
        } catch (error: any) {
          retries++;
          logger.info(`Error inserting commitment (attempt ${retries}): ${error.message}`);

          if (retries < this.retryAttempts) {
            await new Promise((resolve) => setTimeout(resolve, this.retryDelay * retries));
          } else {
            logger.info(`Failed to insert commitment after ${this.retryAttempts} attempts.`);
            throw error;
          }
        }
      }

      return true;
    } catch (error) {
      logger.error('Failed to store commitment:', error);
      throw error;
    }
  }

  public async getCommitmentsForBlock(): Promise<Commitment[]> {
    const cursor = await this.getOrInitializeCursor();
    let commitments: any[] = [];

    if (cursor.status === CursorStatus.COMPLETE) {
      let query = {};

      if (cursor.lastProcessedSequenceId) {
        query = { sequenceId: { $gt: cursor.lastProcessedSequenceId } };
      }

      commitments = await CommitmentModel.find(query).sort({ sequenceId: 1 }).limit(COMMITMENT_BATCH_SIZE);

      if (commitments.length > 0) {
        const endSequenceId = commitments[commitments.length - 1].sequenceId;
        const startSequenceId = commitments[0].sequenceId;

        // Check for gaps in sequence IDs
        const sequenceIds = commitments.map((c) => c.sequenceId).sort((a, b) => a - b);
        const expectedCount = endSequenceId - startSequenceId + 1;

        if (sequenceIds.length < expectedCount) {
          logger.info(
            `WARNING: Sequence ID gap detected! Range ${startSequenceId}-${endSequenceId} should have ${expectedCount} items but found ${sequenceIds.length}`,
          );

          // Try to find and recover missing commitments
          try {
            const missingCommitments = await this.findMissingCommitments(sequenceIds);
            if (missingCommitments.length > 0) {
              commitments.push(...missingCommitments);
              commitments.sort((a, b) => a.sequenceId - b.sequenceId);
            }
          } catch (error) {
            logger.error('Error finding missing commitments:', error);
          }
        }

        logger.info(`Batch: Got ${commitments.length} commitments, sequence range ${startSequenceId}-${endSequenceId}`);

        await this.updateCursor({
          status: CursorStatus.IN_PROGRESS,
          currentBatchEndSequenceId: endSequenceId,
          lastProcessedSequenceId: cursor.lastProcessedSequenceId ?? 0,
        });
      }
    } else if (cursor.status === CursorStatus.IN_PROGRESS) {
      logger.debug(
        `Cursor is IN_PROGRESS. lastProcessedSequenceId: ${cursor.lastProcessedSequenceId}, currentBatchEndSequenceId: ${cursor.currentBatchEndSequenceId}`,
      );

      if (cursor.lastProcessedSequenceId !== undefined && cursor.currentBatchEndSequenceId !== undefined) {
        const query = {
          sequenceId: {
            $gt: cursor.lastProcessedSequenceId,
            $lte: cursor.currentBatchEndSequenceId,
          },
        };
        commitments = await CommitmentModel.find(query).sort({ sequenceId: 1 });
        logger.info(
          `RETRYING: Processing ${commitments.length} commitments again, sequence range ${cursor.lastProcessedSequenceId + 1}-${cursor.currentBatchEndSequenceId}`,
        );
      } else {
        logger.info(`ERROR: Cursor is IN_PROGRESS but missing sequence ID boundaries`);
      }
    }

    return commitments.map((commitment) => {
      const authenticator = new Authenticator(
        commitment.authenticator.algorithm,
        commitment.authenticator.publicKey,
        Signature.decode(commitment.authenticator.signature),
        DataHash.fromImprint(commitment.authenticator.stateHash),
      );
      return new Commitment(
        RequestId.fromJSON(commitment.requestId),
        DataHash.fromImprint(commitment.transactionHash),
        authenticator,
      );
    });
  }

  public async confirmBlockProcessed(): Promise<boolean> {
    const currentCursor = await CursorCheckpointModel.findById('commitmentCursor');
    logger.debug(`Confirming block processed. Current cursor: ${JSON.stringify(currentCursor)}`);

    if (!currentCursor || currentCursor.currentBatchEndSequenceId === undefined) {
      logger.info('Error: Cannot confirm block processed - cursor not found or missing currentBatchEndSequenceId');
      return false;
    }

    const endSequenceId = currentCursor.currentBatchEndSequenceId;

    logger.debug(`Updating cursor from IN_PROGRESS to COMPLETE, setting lastProcessedSequenceId to ${endSequenceId}`);
    const result = await CursorCheckpointModel.updateOne(
      { _id: 'commitmentCursor', status: CursorStatus.IN_PROGRESS },
      {
        $set: {
          lastProcessedSequenceId: endSequenceId,
          status: CursorStatus.COMPLETE,
          currentBatchEndSequenceId: null,
        },
      },
    );
    const success = result.modifiedCount > 0;
    logger.debug(`Confirmation result: ${success ? 'SUCCESS' : 'FAILED'}`);
    return success;
  }

  private async getOrInitializeCursor(): Promise<ICursorCheckpoint> {
    let cursor = await CursorCheckpointModel.findById('commitmentCursor');
    if (!cursor) {
      logger.debug('Creating new cursor checkpoint with initial values');
      cursor = await CursorCheckpointModel.create({
        _id: 'commitmentCursor',
        status: CursorStatus.COMPLETE,
        lastProcessedSequenceId: 0,
      });
    }

    return cursor;
  }

  private async updateCursor(updates: Partial<ICursorCheckpoint>): Promise<void> {
    logger.debug(`Updating cursor: ${JSON.stringify(updates)}`);
    await CursorCheckpointModel.findByIdAndUpdate('commitmentCursor', updates, { upsert: true });
    // Log the updated cursor for debugging
    const updatedCursor = await CursorCheckpointModel.findById('commitmentCursor');
    logger.debug(`Updated cursor state: ${JSON.stringify(updatedCursor)}`);
  }

  private async findMissingCommitments(sequenceIds: number[]): Promise<any[]> {
    const gaps: number[] = [];
    const sortedIds = [...sequenceIds].sort((a, b) => a - b);

    for (let i = 1; i < sortedIds.length; i++) {
      if (sortedIds[i] > sortedIds[i - 1] + 1) {
        for (let j = sortedIds[i - 1] + 1; j < sortedIds[i]; j++) {
          gaps.push(j);
        }
      }
    }

    if (gaps.length === 0) {
      return [];
    }

    logger.info(`Missing sequence IDs: ${gaps.join(', ')}`);

    // Look for these commitments with retry logic
    const recoveredCommitments: any[] = [];
    let retriesLeft = this.retryAttempts;
    let stillMissingCount = gaps.length;

    while (retriesLeft > 0 && stillMissingCount > 0) {
      const foundCommitments = await CommitmentModel.find({
        sequenceId: { $in: gaps },
      });

      if (foundCommitments.length > 0) {
        logger.info(
          `Found ${foundCommitments.length} of ${gaps.length} commitments with missing sequence IDs on try ${this.retryAttempts - retriesLeft + 1}!`,
        );

        // Add the missing commitments to our results
        foundCommitments.forEach((c) => {
          logger.info(`  ID: ${c._id}, SeqID: ${c.sequenceId}, RequestID: ${c.requestId}`);
          recoveredCommitments.push(c);

          const index = gaps.indexOf(c.sequenceId);
          if (index !== -1) {
            gaps.splice(index, 1);
          }
        });

        stillMissingCount = gaps.length;

        if (stillMissingCount === 0) {
          logger.info(`All missing commitments found after ${this.retryAttempts - retriesLeft + 1} attempts!`);
          break;
        }
      }

      if (stillMissingCount === 0 || retriesLeft === 1) {
        break;
      }

      retriesLeft--;
      logger.info(
        `Still missing ${stillMissingCount} commitments. Retrying after delay... (${retriesLeft} retries left)`,
      );
      await new Promise((resolve) => setTimeout(resolve, this.retryDelay * (this.retryAttempts - retriesLeft)));
    }

    if (stillMissingCount > 0) {
      logger.info(
        `WARNING: Unable to find ${stillMissingCount} commitments with sequence IDs: ${gaps.join(', ')} after ${this.retryAttempts} attempts`,
      );
    }

    return recoveredCommitments;
  }
}
