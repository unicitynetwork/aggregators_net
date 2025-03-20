import mongoose, { model } from 'mongoose';

import { SCHEMA_TYPES } from './SchemaTypes.js';

interface ISMTNode {
  path: bigint;
  value: Uint8Array;
}

interface IAggregatorRecord {
  requestId: Uint8Array;
  rootHash: Uint8Array;
  previousBlockData: Uint8Array;
  authenticator: {
    hashAlgorithm: string;
    publicKey: Uint8Array;
    algorithm: string;
    signature: Uint8Array;
    stateHash: Uint8Array;
  };
  txProof: Uint8Array;
}

const LeafSchema = new mongoose.Schema({
  path: { required: true, type: SCHEMA_TYPES.BIGINT_BINARY, unique: true },
  value: { required: true, type: SCHEMA_TYPES.UINT8_ARRAY },
});

const AggregatorRecordSchema = new mongoose.Schema({
  authenticator: {
    algorithm: { required: true, type: String },
    hashAlgorithm: { required: true, type: String },
    publicKey: { required: true, type: SCHEMA_TYPES.UINT8_ARRAY },
    signature: { required: true, type: SCHEMA_TYPES.UINT8_ARRAY },
    stateHash: { required: true, type: SCHEMA_TYPES.UINT8_ARRAY },
  },
  previousBlockData: { required: true, type: SCHEMA_TYPES.UINT8_ARRAY },
  requestId: { required: true, type: SCHEMA_TYPES.UINT8_ARRAY, unique: true },
  rootHash: { required: true, type: SCHEMA_TYPES.UINT8_ARRAY },
  txProof: { required: true, type: SCHEMA_TYPES.UINT8_ARRAY },
});

export const LeafModel = mongoose.model<ISMTNode>('Leaf', LeafSchema);
export const AggregatorRecordModel = model<IAggregatorRecord>('AggregatorRecord', AggregatorRecordSchema);
