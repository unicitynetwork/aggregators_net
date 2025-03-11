import { type UpdateNonFungibleTokenTransactionOrder } from '@alphabill/alphabill-js-sdk/lib/tokens/transactions/UpdateNonFungibleToken';
import { TransactionRecordWithProof } from '@alphabill/alphabill-js-sdk/lib/transaction/record/TransactionRecordWithProof';
import { dedent } from '@alphabill/alphabill-js-sdk/lib/util/StringUtils';
import { Authenticator } from '@unicitylabs/commons/lib/api/Authenticator';
import { HexConverter } from '@unicitylabs/commons/lib/util/HexConverter';

export class AggregatorRecord {
  public constructor(
    private readonly _rootHash: Uint8Array,
    private readonly _previousBlockData: Uint8Array | null,
    public readonly authenticator: Authenticator,
    public readonly txProof: TransactionRecordWithProof<UpdateNonFungibleTokenTransactionOrder>,
  ) {
    this._rootHash = new Uint8Array(_rootHash);
    this._previousBlockData = _previousBlockData ? new Uint8Array(_previousBlockData) : null;
  }

  public get rootHash(): Uint8Array {
    return new Uint8Array(this._rootHash);
  }

  public get previousBlockData(): Uint8Array | null {
    return this._previousBlockData ? new Uint8Array(this._previousBlockData) : null;
  }

  public toString(): string {
    return dedent`
      Aggregator Record
        Root Hash: ${HexConverter.encode(this._rootHash)}
        Previous Block Data: ${this._previousBlockData ? HexConverter.encode(this._previousBlockData) : 'null'}
        ${this.authenticator.toString()}
        ${this.txProof.toString()}`;
  }
}
