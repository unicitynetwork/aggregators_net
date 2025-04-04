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

const CommitmentModel = model<ICommitment>('Commitment', CommitmentSchema);

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
    // TODO how to keep track of cursor?
    const stored = await CommitmentModel.find({});
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
}
