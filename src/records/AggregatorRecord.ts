import { type UpdateNonFungibleTokenTransactionOrder } from '@alphabill/alphabill-js-sdk/lib/tokens/transactions/UpdateNonFungibleToken.js';
import { TransactionRecordWithProof } from '@alphabill/alphabill-js-sdk/lib/transaction/record/TransactionRecordWithProof.js';
import { dedent } from '@alphabill/alphabill-js-sdk/lib/util/StringUtils.js';
import { Authenticator } from '@unicitylabs/commons/lib/api/Authenticator.js';
import { DataHash } from '@unicitylabs/commons/lib/hash/DataHash.js';
import { HexConverter } from '@unicitylabs/commons/lib/util/HexConverter.js';

export class AggregatorRecord {
  public constructor(
    public readonly chainId: number,
    public readonly version: number,
    public readonly forkId: number,
    public readonly blockNumber: bigint,
    public readonly timestamp: bigint,
    public readonly txProof: TransactionRecordWithProof<UpdateNonFungibleTokenTransactionOrder>,
    private readonly _previousBlockHash: Uint8Array | null,
    public readonly rootHash: DataHash,
    private readonly _noDeletionProofHash: Uint8Array | null,
    public readonly authenticator: Authenticator,
  ) {
    this._previousBlockHash = _previousBlockHash ? new Uint8Array(_previousBlockHash) : null;
    this._noDeletionProofHash = _noDeletionProofHash ? new Uint8Array(_noDeletionProofHash) : null;
  }

  public get previousBlockHash(): Uint8Array | null {
    return this._previousBlockHash ? new Uint8Array(this._previousBlockHash) : null;
  }

  public get noDeletionProofHash(): Uint8Array | null {
    return this._noDeletionProofHash ? new Uint8Array(this._noDeletionProofHash) : null;
  }

  public toString(): string {
    return dedent`
      Aggregator Record
        Chain ID: ${this.chainId}
        Version: ${this.version}
        Fork ID: ${this.forkId}
        Block Number: ${this.blockNumber}
        Timestamp: ${this.timestamp}
        ${this.txProof.toString()}
        Previous Block Hash: ${this._previousBlockHash ? HexConverter.encode(this._previousBlockHash) : 'null'}
        SMT Root Hash: ${this.rootHash.toString()}
        No Deletion Proof: ${this._noDeletionProofHash ? HexConverter.encode(this._noDeletionProofHash) : 'null'}
        ${this.authenticator.toString()}`;
  }
}
