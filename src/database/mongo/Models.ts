import mongoose, { model } from 'mongoose';

import { SCHEMA_TYPES } from './SchemaTypes.js';

interface ISMTNode {
  path: bigint;
  value: Uint8Array;
}

interface IAggregatorRecord {
  chainId: number;
  version: number;
  forkId: number;
  blockNumber: bigint;
  timestamp: bigint;
  requestId: bigint;
  rootHash: Uint8Array;
  previousBlockHash: Uint8Array | null;
  txProof: Uint8Array;
  noDeletionProof: Uint8Array | null;
  authenticator: {
    publicKey: Uint8Array;
    algorithm: string;
    signature: Uint8Array;
    stateHash: Uint8Array;
  };
}

const LeafSchema = new mongoose.Schema({
  path: { required: true, type: SCHEMA_TYPES.BIGINT_BINARY, unique: true },
  value: { required: true, type: SCHEMA_TYPES.UINT8_ARRAY },
});

const AggregatorRecordSchema = new mongoose.Schema({
  requestId: { required: true, type: SCHEMA_TYPES.BIGINT_BINARY, unique: true },
  chainId: { required: true, type: Number },
  version: { required: true, type: Number },
  forkId: { required: true, type: Number },
  blockNumber: { index: true, required: true, type: SCHEMA_TYPES.BIGINT_BINARY },
  txProof: { required: true, type: SCHEMA_TYPES.UINT8_ARRAY },
  previousBlockHash: { required: false, type: SCHEMA_TYPES.UINT8_ARRAY },
  rootHash: { required: true, type: SCHEMA_TYPES.UINT8_ARRAY },
  noDeletionProofHash: { required: false, type: SCHEMA_TYPES.UINT8_ARRAY },
  authenticator: {
    algorithm: { required: true, type: String },
    publicKey: { required: true, type: SCHEMA_TYPES.UINT8_ARRAY },
    signature: { required: true, type: SCHEMA_TYPES.UINT8_ARRAY },
    stateHash: { required: true, type: SCHEMA_TYPES.UINT8_ARRAY },
  },
});

export const LeafModel = model<ISMTNode>('Leaf', LeafSchema);
export const AggregatorRecordModel = model<IAggregatorRecord>('AggregatorRecord', AggregatorRecordSchema);
