import { type UpdateNonFungibleTokenTransactionOrder } from '@unicitylabs/bft-js-sdk/lib/tokens/transactions/UpdateNonFungibleToken.js';
import { TransactionRecordWithProof } from '@unicitylabs/bft-js-sdk/lib/transaction/record/TransactionRecordWithProof.js';
import { DataHash } from '@unicitylabs/commons/lib/hash/DataHash.js';
import { HexConverter } from '@unicitylabs/commons/lib/util/HexConverter.js';
import { dedent } from '@unicitylabs/commons/lib/util/StringUtils.js';

export class Block {
  public constructor(
    public readonly index: bigint,
    public readonly chainId: number,
    public readonly version: number,
    public readonly forkId: number,
    public readonly timestamp: bigint,
    public readonly txProof: TransactionRecordWithProof<UpdateNonFungibleTokenTransactionOrder>,
    private readonly _previousBlockHash: Uint8Array,
    public readonly rootHash: DataHash,
    private readonly _noDeletionProofHash: Uint8Array | null,
  ) {
    this._previousBlockHash = new Uint8Array(_previousBlockHash);
    this._noDeletionProofHash = _noDeletionProofHash ? new Uint8Array(_noDeletionProofHash) : null;
  }

  public get previousBlockHash(): Uint8Array {
    return new Uint8Array(this._previousBlockHash);
  }

  public get noDeletionProofHash(): Uint8Array | null {
    return this._noDeletionProofHash ? new Uint8Array(this._noDeletionProofHash) : null;
  }

  public toString(): string {
    return dedent`
      Block
        Index: ${this.index}
        Chain ID: ${this.chainId}
        Version: ${this.version}
        Fork ID: ${this.forkId}
        Timestamp: ${this.timestamp}
        ${this.txProof.toString()}
        Previous Block Hash: ${HexConverter.encode(this._previousBlockHash)}
        Root Hash: ${this.rootHash.toString()}
        No Deletion Proof Hash: ${this._noDeletionProofHash ? HexConverter.encode(this._noDeletionProofHash) : 'null'}`;
  }
}
