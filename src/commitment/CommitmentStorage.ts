import { Authenticator } from '@unicitylabs/commons/lib/api/Authenticator.js';
import { RequestId } from '@unicitylabs/commons/lib/api/RequestId.js';
import { DataHash } from '@unicitylabs/commons/lib/hash/DataHash.js';
import { Signature } from '@unicitylabs/commons/lib/signing/Signature.js';
import mongoose, { model, Schema } from 'mongoose';

import { SCHEMA_TYPES } from '../StorageSchemaTypes.js';
import { Commitment } from './Commitment.js';
import { ICommitmentStorage } from './ICommitmentStorage.js';

interface ICommitment {
  requestId: string;
  transactionHash: Uint8Array;
  authenticator: {
    publicKey: Uint8Array;
    algorithm: string;
    signature: Uint8Array;
    stateHash: Uint8Array;
  };
}

enum CursorStatus {
  COMPLETE = 'COMPLETE',
  IN_PROGRESS = 'IN_PROGRESS'
}

const COMMITMENT_BATCH_SIZE = 1000;

interface ICursorCheckpoint {
  // ID of the last successfully processed commitment
  lastProcessedId: Schema.Types.ObjectId;
  // Status of the cursor
  status: string;
  // End ID of the current batch being processed (when status is IN_PROGRESS)
  currentBatchEndId?: Schema.Types.ObjectId;
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
    lastProcessedId: { type: Schema.Types.ObjectId },
    status: { 
      type: String, 
      enum: [CursorStatus.COMPLETE, CursorStatus.IN_PROGRESS],
      default: CursorStatus.COMPLETE 
    },
    currentBatchEndId: { type: Schema.Types.ObjectId },
  },
  {
    timestamps: true, // Add timestamps to track when the cursor was last updated
  }
);

const CommitmentModel = model<ICommitment>('Commitment', CommitmentSchema);
const CursorCheckpointModel = model<ICursorCheckpoint>('CursorCheckpoint', CursorCheckpointSchema);

export class CommitmentStorage implements ICommitmentStorage {
  public async put(commitment: Commitment): Promise<boolean> {
    await new CommitmentModel({
      requestId: commitment.requestId.toDto(),
      transactionHash: commitment.transactionHash.imprint,
      authenticator: {
        algorithm: commitment.authenticator.algorithm,
        publicKey: commitment.authenticator.publicKey,
        signature: commitment.authenticator.signature.encode(),
        stateHash: commitment.authenticator.stateHash.imprint,
      },
    }).save();
    return true;
  }

  public async getCommitmentsForBlock(): Promise<Commitment[]> {
    const cursor = await this.getOrInitializeCursor();
    
    let query = {};
    let commitments: any[] = [];
    
    if (cursor.status === CursorStatus.COMPLETE) {
      if (cursor.lastProcessedId) {
        query = { _id: { $gt: cursor.lastProcessedId } };
      }
      
      commitments = await CommitmentModel.find(query).sort({ _id: 1 }).limit(COMMITMENT_BATCH_SIZE);
      
      if (commitments.length > 0) {
        const endId = commitments[commitments.length - 1]._id;
        await this.updateCursor({
          status: CursorStatus.IN_PROGRESS,
          currentBatchEndId: endId,
        });
      }
    } else {
      if (cursor.lastProcessedId && cursor.currentBatchEndId) {
        query = { 
          _id: { 
            $gt: cursor.lastProcessedId,
            $lte: cursor.currentBatchEndId 
          } 
        };
        commitments = await CommitmentModel.find(query).sort({ _id: 1 });
      }
    }
    
    return commitments.map((commitment) => {
      const authenticator = new Authenticator(
        commitment.authenticator.publicKey,
        commitment.authenticator.algorithm,
        new Signature(commitment.authenticator.signature.slice(0, -1), commitment.authenticator.signature[65]),
        DataHash.fromImprint(commitment.authenticator.stateHash),
      );
      return new Commitment(
        RequestId.fromDto(commitment.requestId),
        DataHash.fromImprint(commitment.transactionHash),
        authenticator,
      );
    });
  }

  public async confirmBlockProcessed(): Promise<boolean> {
    const result = await CursorCheckpointModel.updateOne(
      { _id: 'commitmentCursor', status: CursorStatus.IN_PROGRESS },
      [
        { 
          $set: { 
            lastProcessedId: '$currentBatchEndId', 
            status: CursorStatus.COMPLETE,
            currentBatchEndId: null
          } 
        }
      ]
    );
    
    return result.modifiedCount > 0;
  }

  private async getOrInitializeCursor(): Promise<ICursorCheckpoint> {
    let cursor = await CursorCheckpointModel.findById('commitmentCursor');
    if (!cursor) {
      cursor = await CursorCheckpointModel.create({
        _id: 'commitmentCursor',
        status: CursorStatus.COMPLETE,
      });
    }
    
    return cursor;
  }

  private async updateCursor(updates: Partial<ICursorCheckpoint>): Promise<void> {
    await CursorCheckpointModel.findByIdAndUpdate(
      'commitmentCursor',
      updates,
      { upsert: true }
    );
  }
}
