import { UpdateNonFungibleTokenAttributes } from '@alphabill/alphabill-js-sdk/lib/tokens/attributes/UpdateNonFungibleTokenAttributes.js';
import { type UpdateNonFungibleTokenTransactionOrder } from '@alphabill/alphabill-js-sdk/lib/tokens/transactions/UpdateNonFungibleToken.js';
import { TypeDataUpdateProofsAuthProof } from '@alphabill/alphabill-js-sdk/lib/transaction/proofs/TypeDataUpdateProofsAuthProof.js';
import { TransactionRecordWithProof } from '@alphabill/alphabill-js-sdk/lib/transaction/record/TransactionRecordWithProof.js';
import { DataHash } from '@unicitylabs/commons/lib/hash/DataHash.js';
import mongoose, { model } from 'mongoose';

import { Block } from './Block.js';
import { IBlockStorage } from './IBlockStorage.js';
import { SCHEMA_TYPES } from '../StorageSchemaTypes.js';

interface IBlock {
  index: bigint;
  chainId: number;
  version: number;
  forkId: number;
  timestamp: bigint;
  txProof: Uint8Array;
  previousBlockHash: Uint8Array;
  rootHash: Uint8Array;
  noDeletionProofHash: Uint8Array | null;
}

const BlockSchema = new mongoose.Schema({
  index: { index: true, required: true, type: SCHEMA_TYPES.BIGINT_BINARY },
  chainId: { required: true, type: Number },
  version: { required: true, type: Number },
  forkId: { required: true, type: Number },
  txProof: { required: true, type: SCHEMA_TYPES.UINT8_ARRAY },
  previousBlockHash: { required: true, type: SCHEMA_TYPES.UINT8_ARRAY },
  rootHash: { required: true, type: SCHEMA_TYPES.UINT8_ARRAY },
  noDeletionProofHash: { required: false, type: SCHEMA_TYPES.UINT8_ARRAY },
});

const BlockModel = model<IBlock>('Block', BlockSchema);

export class BlockStorage implements IBlockStorage {
  public async put(block: Block, session?: mongoose.ClientSession): Promise<boolean> {
    const blockDoc = new BlockModel({
      index: block.index,
      chainId: block.chainId,
      version: block.version,
      forkId: block.forkId,
      timestamp: block.timestamp,
      txProof: block.txProof.encode(),
      previousBlockHash: block.previousBlockHash,
      rootHash: block.rootHash.imprint,
      noDeletionProofHash: block.noDeletionProofHash,
    });

    await blockDoc.save({ session });
    return true;
  }

  public async get(index: bigint): Promise<Block | null> {
    const stored = await BlockModel.findOne({ index: index });

    if (!stored) {
      return null;
    }

    const rootHash = DataHash.fromImprint(stored.rootHash);
    const decodedProof = this.decodeTxProof(stored.txProof);
    const timestamp = decodedProof.transactionProof.unicityCertificate.unicitySeal.timestamp;
    return new Block(
      stored.index,
      stored.chainId,
      stored.version,
      stored.forkId,
      timestamp,
      decodedProof,
      stored.previousBlockHash,
      rootHash,
      null, // TODO Add noDeletionProof
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
