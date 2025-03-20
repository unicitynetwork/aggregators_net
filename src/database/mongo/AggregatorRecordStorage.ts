import { UpdateNonFungibleTokenAttributes } from '@alphabill/alphabill-js-sdk/lib/tokens/attributes/UpdateNonFungibleTokenAttributes.js';
import { TypeDataUpdateProofsAuthProof } from '@alphabill/alphabill-js-sdk/lib/transaction/proofs/TypeDataUpdateProofsAuthProof.js';
import { TransactionRecordWithProof } from '@alphabill/alphabill-js-sdk/lib/transaction/record/TransactionRecordWithProof.js';
import { Authenticator } from '@unicitylabs/commons/lib/api/Authenticator.js';
import { RequestId } from '@unicitylabs/commons/lib/api/RequestId.js';

import { AggregatorRecordModel } from './Models.js';
import { AggregatorRecord } from '../../records/AggregatorRecord.js';
import { IAggregatorRecordStorage } from '../../records/IAggregatorRecordStorage.js';

export class AggregatorRecordStorage implements IAggregatorRecordStorage {
  public async put(requestId: RequestId, record: AggregatorRecord): Promise<boolean> {
    await new AggregatorRecordModel({
      authenticator: {
        algorithm: record.authenticator.algorithm,
        hashAlgorithm: record.authenticator.hashAlgorithm,
        publicKey: record.authenticator.publicKey,
        signature: record.authenticator.signature,
        state: record.authenticator.state,
      },
      previousBlockData: record.previousBlockData || new Uint8Array(),
      requestId: requestId.encode(),
      rootHash: record.rootHash,
      txProof: record.txProof.encode(),
    }).save();
    return true;
  }

  public async get(requestId: RequestId): Promise<AggregatorRecord | null> {
    const stored = await AggregatorRecordModel.findOne({ requestId: requestId.encode() });

    if (!stored) {
      return null;
    }

    const decodedProof = TransactionRecordWithProof.fromCbor(
      stored.txProof,
      {
        fromCbor: (bytes: Uint8Array) => UpdateNonFungibleTokenAttributes.fromCbor(bytes),
      },
      {
        fromCbor: (bytes: Uint8Array) => TypeDataUpdateProofsAuthProof.fromCbor(bytes),
      },
    );

    const authenticator = new Authenticator(
      stored.authenticator.hashAlgorithm,
      stored.authenticator.publicKey,
      stored.authenticator.algorithm,
      stored.authenticator.signature,
      stored.authenticator.state,
    );

    return new AggregatorRecord(stored.rootHash, stored.previousBlockData || null, authenticator, decodedProof);
  }
}
