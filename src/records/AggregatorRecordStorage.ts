import { Authenticator } from '@unicitylabs/commons/lib/api/Authenticator.js';
import { RequestId } from '@unicitylabs/commons/lib/api/RequestId.js';
import { DataHash } from '@unicitylabs/commons/lib/hash/DataHash.js';
import { Signature } from '@unicitylabs/commons/lib/signing/Signature.js';
import mongoose, { model } from 'mongoose';

import { AggregatorRecord } from './AggregatorRecord.js';
import { IAggregatorRecordStorage } from './IAggregatorRecordStorage.js';
import logger from '../logger.js';
import { SCHEMA_TYPES } from '../StorageSchemaTypes.js';

interface IAggregatorRecord {
  requestId: bigint;
  transactionHash: Uint8Array;
  authenticator: {
    publicKey: Uint8Array;
    algorithm: string;
    signature: Uint8Array;
    stateHash: Uint8Array;
  };
}

const AggregatorRecordSchema = new mongoose.Schema({
  requestId: { required: true, type: SCHEMA_TYPES.BIGINT_BINARY, unique: true },
  transactionHash: { required: true, type: SCHEMA_TYPES.UINT8_ARRAY },
  authenticator: {
    algorithm: { required: true, type: String },
    publicKey: { required: true, type: SCHEMA_TYPES.UINT8_ARRAY },
    signature: { required: true, type: SCHEMA_TYPES.UINT8_ARRAY },
    stateHash: { required: true, type: SCHEMA_TYPES.UINT8_ARRAY },
  },
});

const AggregatorRecordModel = model<IAggregatorRecord>('AggregatorRecord', AggregatorRecordSchema);

export class AggregatorRecordStorage implements IAggregatorRecordStorage {
  public async put(record: AggregatorRecord): Promise<boolean> {
    const loggerWithMetadata = logger.child({ requestId: record.requestId.toString() });
    try {
      await new AggregatorRecordModel({
        requestId: record.requestId.toBigInt(),
        transactionHash: record.transactionHash.imprint,
        authenticator: {
          algorithm: record.authenticator.algorithm,
          publicKey: record.authenticator.publicKey,
          signature: record.authenticator.signature.encode(),
          stateHash: record.authenticator.stateHash.imprint,
        },
      }).save();
      return true;
    } catch (error) {
      loggerWithMetadata.error('Failed to store aggregator record:', error);
      throw error;
    }
  }

  public async putBatch(records: AggregatorRecord[]): Promise<boolean> {
    if (records.length === 0) {
      return true;
    }

    try {
      // Use bulkWrite with insertOne operations that will not update existing records
      const operations = records.map((record) => ({
        updateOne: {
          filter: { requestId: record.requestId.toBigInt() },
          update: {
            $setOnInsert: {
              requestId: record.requestId.toBigInt(),
              transactionHash: record.transactionHash.imprint,
              authenticator: {
                algorithm: record.authenticator.algorithm,
                publicKey: record.authenticator.publicKey,
                signature: record.authenticator.signature.encode(),
                stateHash: record.authenticator.stateHash.imprint,
              },
            },
          },
          upsert: true,
        },
      }));

      await AggregatorRecordModel.bulkWrite(operations);
      return true;
    } catch (error) {
      logger.error('Error in AggregatorRecordStorage putBatch:', error);
      throw error;
    }
  }

  public async get(requestId: RequestId): Promise<AggregatorRecord | null> {
    const stored = await AggregatorRecordModel.findOne({ requestId: requestId.toBigInt() });
    if (!stored) {
      return null;
    }
    const authenticator = new Authenticator(
      stored.authenticator.publicKey,
      stored.authenticator.algorithm,
      Signature.decode(stored.authenticator.signature),
      DataHash.fromImprint(stored.authenticator.stateHash),
    );
    return new AggregatorRecord(requestId, DataHash.fromImprint(stored.transactionHash), authenticator);
  }

  public async getByRequestIds(requestIds: RequestId[]): Promise<AggregatorRecord[]> {
    if (requestIds.length === 0) {
      return [];
    }

    const requestIdBigInts = requestIds.map((id) => id.toBigInt());
    const storedRecords = await AggregatorRecordModel.find({
      requestId: { $in: requestIdBigInts },
    });

    return storedRecords.map((stored) => {
      const originalRequestId = requestIds.find((id) => id.toBigInt() === stored.requestId)!;

      const authenticator = new Authenticator(
        stored.authenticator.publicKey,
        stored.authenticator.algorithm,
        Signature.decode(stored.authenticator.signature),
        DataHash.fromImprint(stored.authenticator.stateHash),
      );

      return new AggregatorRecord(originalRequestId, DataHash.fromImprint(stored.transactionHash), authenticator);
    });
  }
}
