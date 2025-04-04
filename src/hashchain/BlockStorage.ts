import { UpdateNonFungibleTokenAttributes } from '@alphabill/alphabill-js-sdk/lib/tokens/attributes/UpdateNonFungibleTokenAttributes.js';
import { type UpdateNonFungibleTokenTransactionOrder } from '@alphabill/alphabill-js-sdk/lib/tokens/transactions/UpdateNonFungibleToken.js';
import { TypeDataUpdateProofsAuthProof } from '@alphabill/alphabill-js-sdk/lib/transaction/proofs/TypeDataUpdateProofsAuthProof.js';
import { TransactionRecordWithProof } from '@alphabill/alphabill-js-sdk/lib/transaction/record/TransactionRecordWithProof.js';
import { Authenticator } from '@unicitylabs/commons/lib/api/Authenticator.js';
import { RequestId } from '@unicitylabs/commons/lib/api/RequestId.js';
import { DataHash } from '@unicitylabs/commons/lib/hash/DataHash.js';
import { Signature } from '@unicitylabs/commons/lib/signing/Signature.js';
import mongoose, { model } from 'mongoose';

import { Block } from './Block.js';
import { IBlock } from './IBlock.js';
import { IBlockStorage } from './IBlockStorage.js';
import { SCHEMA_TYPES } from '../StorageSchemaTypes.js';

const BlockSchema = new mongoose.Schema({
  requestId: { required: true, type: SCHEMA_TYPES.BIGINT_BINARY, unique: true }, // TODO needed?
  index: { index: true, required: true, type: SCHEMA_TYPES.BIGINT_BINARY },
  chainId: { required: true, type: Number },
  version: { required: true, type: Number },
  forkId: { required: true, type: Number },
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
const BlockModel = model<IBlock>('Block', BlockSchema);

export class BlockStorage implements IBlockStorage {
  public async put(requestId: RequestId, block: Block): Promise<boolean> {
    await new BlockModel({
      requestId: requestId.toBigInt(),
      index: block.index,
      chainId: block.chainId,
      version: block.version,
      forkId: block.forkId,
      timestamp: block.timestamp,
      txProof: block.txProof.encode(),
      previousBlockHash: block.previousBlockHash ?? new Uint8Array(),
      rootHash: block.rootHash.imprint,
      noDeletionProofHash: block.noDeletionProofHash,
      authenticator: {
        algorithm: block.authenticator.algorithm,
        publicKey: block.authenticator.publicKey,
        signature: block.authenticator.signature.encode(),
        stateHash: block.authenticator.stateHash.imprint,
      },
    }).save();
    return true;
  }

  public async get(requestId: RequestId): Promise<Block | null> {
    const stored = await BlockModel.findOne({ requestId: requestId.toBigInt() });

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
    return new Block(
      stored.index,
      stored.chainId,
      stored.version,
      stored.forkId,
      timestamp,
      decodedProof,
      stored.previousBlockHash ?? null,
      rootHash,
      null, // TODO Add noDeletionProof
      authenticator,
    );
  }

  public async getNextBlockNumber(): Promise<bigint> {
    const stored = await BlockModel.findOne({}, null, { sort: { index: -1 } });
    if (!stored) {
      return 1n;
    }
    return BigInt(stored.index) + 1n;
  }

  private decodeTxProof(txProofBytes: Uint8Array): TransactionRecordWithProof<UpdateNonFungibleTokenTransactionOrder> {
    return TransactionRecordWithProof.fromCbor(
      txProofBytes,
      { fromCbor: (bytes: Uint8Array) => UpdateNonFungibleTokenAttributes.fromCbor(bytes) },
      { fromCbor: (bytes: Uint8Array) => TypeDataUpdateProofsAuthProof.fromCbor(bytes) },
    );
  }
}
