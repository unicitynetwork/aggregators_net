import mongoose, { model } from "mongoose";
import { SCHEMA_TYPES } from "./SchemaTypes.js"

interface ISMTNode {
    path: bigint;
    value: Uint8Array;
}

interface IAggregatorRecord {
    requestId: bigint;
    rootHash: Uint8Array;
    previousBlockData: Uint8Array;
    authenticator: {
        hashAlgorithm: string;
        publicKey: Uint8Array;
        algorithm: string;
        signature: Uint8Array;
        state: Uint8Array;
    };
    txProof: Uint8Array;
}

const LeafSchema = new mongoose.Schema({
    path: { type: SCHEMA_TYPES.BIGINT_BINARY, required: true, unique: true },
    value: { type: SCHEMA_TYPES.UINT8_ARRAY, required: true }
});
  
const AggregatorRecordSchema = new mongoose.Schema({
    requestId: { type: SCHEMA_TYPES.BIGINT_BINARY, required: true, unique: true },
    rootHash: { type: SCHEMA_TYPES.UINT8_ARRAY, required: true },
    previousBlockData: { type: SCHEMA_TYPES.UINT8_ARRAY, required: true },
    authenticator: {
        hashAlgorithm: { type: String, required: true },
        publicKey: { type: SCHEMA_TYPES.UINT8_ARRAY, required: true },
        algorithm: { type: String, required: true },
        signature: { type: SCHEMA_TYPES.UINT8_ARRAY, required: true },
        state: { type: SCHEMA_TYPES.UINT8_ARRAY, required: true }
    },
    txProof: { type: SCHEMA_TYPES.UINT8_ARRAY, required: true }
});

export const LeafModel = mongoose.model<ISMTNode>("Leaf", LeafSchema);
export const AggregatorRecordModel = model<IAggregatorRecord>('AggregatorRecord', AggregatorRecordSchema);
