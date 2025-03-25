import { UpdateNonFungibleTokenAttributes } from '@alphabill/alphabill-js-sdk/lib/tokens/attributes/UpdateNonFungibleTokenAttributes.js';
import { type UpdateNonFungibleTokenTransactionOrder } from '@alphabill/alphabill-js-sdk/lib/tokens/transactions/UpdateNonFungibleToken.js';
import { TypeDataUpdateProofsAuthProof } from '@alphabill/alphabill-js-sdk/lib/transaction/proofs/TypeDataUpdateProofsAuthProof.js';
import { TransactionRecordWithProof } from '@alphabill/alphabill-js-sdk/lib/transaction/record/TransactionRecordWithProof.js';
import { Authenticator } from '@unicitylabs/commons/lib/api/Authenticator.js';
import { RequestId } from '@unicitylabs/commons/lib/api/RequestId.js';
import { DataHash } from '@unicitylabs/commons/lib/hash/DataHash.js';

import { AggregatorRecordModel } from './Models.js';
import { AggregatorRecord } from '../../records/AggregatorRecord.js';
import { IAggregatorRecordStorage } from '../../records/IAggregatorRecordStorage.js';

export class AggregatorRecordStorage implements IAggregatorRecordStorage {
  public async put(requestId: RequestId, record: AggregatorRecord): Promise<boolean> {
    await new AggregatorRecordModel({
      authenticator: {
        algorithm: record.authenticator.algorithm,
        publicKey: record.authenticator.publicKey,
        signature: record.authenticator.signature,
        stateHash: record.authenticator.stateHash.imprint,
      },
      previousBlockData: record.previousBlockData || new Uint8Array(),
      requestId: requestId.toBigInt(),
      rootHash: record.rootHash.imprint,
      txProof: record.txProof.encode(),
    }).save();
    return true;
  }

  public async get(requestId: RequestId): Promise<AggregatorRecord | null> {
    const stored = await AggregatorRecordModel.findOne({ requestId: requestId.toBigInt() });

    if (!stored) {
      return null;
    }

    const rootHash = DataHash.fromImprint(stored.rootHash);
    const authenticator = new Authenticator(
      stored.authenticator.publicKey,
      stored.authenticator.algorithm,
      stored.authenticator.signature,
      DataHash.fromImprint(stored.authenticator.stateHash),
    );
    const decodedProof = this.decodeTxProof(stored.txProof);
    return new AggregatorRecord(rootHash, stored.previousBlockData || null, authenticator, decodedProof);
  }

  private decodeTxProof(txProofBytes: Uint8Array): TransactionRecordWithProof<UpdateNonFungibleTokenTransactionOrder> {
    return TransactionRecordWithProof.fromCbor(
      txProofBytes,
      { fromCbor: (bytes: Uint8Array) => UpdateNonFungibleTokenAttributes.fromCbor(bytes) },
      { fromCbor: (bytes: Uint8Array) => TypeDataUpdateProofsAuthProof.fromCbor(bytes) },
    );
  }
}
