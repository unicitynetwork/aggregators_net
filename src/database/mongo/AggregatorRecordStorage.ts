import { UpdateNonFungibleTokenAttributes } from '@alphabill/alphabill-js-sdk/lib/tokens/attributes/UpdateNonFungibleTokenAttributes.js';
import { type UpdateNonFungibleTokenTransactionOrder } from '@alphabill/alphabill-js-sdk/lib/tokens/transactions/UpdateNonFungibleToken.js';
import { TypeDataUpdateProofsAuthProof } from '@alphabill/alphabill-js-sdk/lib/transaction/proofs/TypeDataUpdateProofsAuthProof.js';
import { TransactionRecordWithProof } from '@alphabill/alphabill-js-sdk/lib/transaction/record/TransactionRecordWithProof.js';
import { Authenticator } from '@unicitylabs/commons/lib/api/Authenticator.js';
import { RequestId } from '@unicitylabs/commons/lib/api/RequestId.js';
import { DataHash } from '@unicitylabs/commons/lib/hash/DataHash.js';
import { Signature } from '@unicitylabs/commons/lib/signing/Signature.js';

import { AggregatorRecordModel } from './Models.js';
import { AggregatorRecord } from '../../records/AggregatorRecord.js';
import { IAggregatorRecordStorage } from '../../records/IAggregatorRecordStorage.js';

export class AggregatorRecordStorage implements IAggregatorRecordStorage {
  public async put(requestId: RequestId, record: AggregatorRecord): Promise<boolean> {
    await new AggregatorRecordModel({
      requestId: requestId.toBigInt(),
      chainId: record.chainId,
      version: record.version,
      forkId: record.forkId,
      blockNumber: record.blockNumber,
      timestamp: record.timestamp,
      txProof: record.txProof.encode(),
      previousBlockHash: record.previousBlockHash ?? new Uint8Array(),
      rootHash: record.rootHash.imprint,
      noDeletionProofHash: record.noDeletionProofHash,
      authenticator: {
        algorithm: record.authenticator.algorithm,
        publicKey: record.authenticator.publicKey,
        signature: record.authenticator.signature.encode(),
        stateHash: record.authenticator.stateHash.imprint,
      },
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
      new Signature(stored.authenticator.signature.slice(0, -1), stored.authenticator.signature[65]),
      DataHash.fromImprint(stored.authenticator.stateHash),
    );
    const decodedProof = this.decodeTxProof(stored.txProof);
    const timestamp = decodedProof.transactionProof.unicityCertificate.unicitySeal.timestamp;
    return new AggregatorRecord(
      stored.chainId,
      stored.version,
      stored.forkId,
      stored.blockNumber,
      timestamp,
      decodedProof,
      stored.previousBlockHash ?? null,
      rootHash,
      null, // TODO Add noDeletionProof
      authenticator,
    );
  }

  public async getNextBlockNumber(): Promise<bigint> {
    const stored = await AggregatorRecordModel.findOne({}, null, { sort: { blockNumber: -1 } });
    if (!stored) {
      return 1n;
    }
    return BigInt(stored.blockNumber) + 1n;
  }

  private decodeTxProof(txProofBytes: Uint8Array): TransactionRecordWithProof<UpdateNonFungibleTokenTransactionOrder> {
    return TransactionRecordWithProof.fromCbor(
      txProofBytes,
      { fromCbor: (bytes: Uint8Array) => UpdateNonFungibleTokenAttributes.fromCbor(bytes) },
      { fromCbor: (bytes: Uint8Array) => TypeDataUpdateProofsAuthProof.fromCbor(bytes) },
    );
  }
}
