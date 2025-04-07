import { Authenticator } from '@unicitylabs/commons/lib/api/Authenticator.js';
import { RequestId } from '@unicitylabs/commons/lib/api/RequestId.js';
import { DataHash } from '@unicitylabs/commons/lib/hash/DataHash.js';
import { Signature } from '@unicitylabs/commons/lib/signing/Signature.js';
import mongoose, { model } from 'mongoose';

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

interface ICursorCheckpoint {
  lastId: mongoose.Types.ObjectId;
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
      size: 1024 * 1024,
    },
  },
);

const CursorCheckpointSchema = new mongoose.Schema(
  {
    lastId: { required: true, type: mongoose.Types.ObjectId, unique: true },
  },
  {
    capped: {
      size: 4096,
      max: 1,
    },
  },
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

  public async getAll(): Promise<Commitment[]> {
    const cursorObjectId = await this.getCursor();
    let filter;
    if (cursorObjectId) {
      filter = { _id: { $gt: cursorObjectId } };
    }
    const stored = await CommitmentModel.find({ filter });
    if (stored.length > 0) {
      const latestId: mongoose.Types.ObjectId = stored[stored.length - 1]._id;
      if (latestId) {
        await this.updateCursor(latestId);
      }
    }
    return stored.map((commitment) => {
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

  private async updateCursor(id: mongoose.Types.ObjectId): Promise<boolean> {
    await CursorCheckpointModel.insertOne({ lastId: id });
    return true;
  }

  private async getCursor(): Promise<mongoose.Types.ObjectId | null> {
    const checkpoint = await CursorCheckpointModel.findOne();
    if (checkpoint) {
      return checkpoint.lastId;
    }
    return null;
  }
}
