import type { UpdateNonFungibleTokenTransactionOrder } from '@alphabill/alphabill-js-sdk/lib/tokens/transactions/UpdateNonFungibleToken.js';
import { TransactionRecordWithProof } from '@alphabill/alphabill-js-sdk/lib/transaction/record/TransactionRecordWithProof.js';
import { dedent } from '@alphabill/alphabill-js-sdk/lib/util/StringUtils.js';
import { HexConverter } from '@unicitylabs/commons/lib/util/HexConverter.js';

export class SubmitHashResponse {
  public constructor(
    private readonly _previousBlockData: Uint8Array | null,
    public readonly txProof: TransactionRecordWithProof<UpdateNonFungibleTokenTransactionOrder>,
  ) {
    this._previousBlockData = _previousBlockData ? new Uint8Array(_previousBlockData) : null;
  }

  public get previousBlockData(): Uint8Array | null {
    return this._previousBlockData ? new Uint8Array(this._previousBlockData) : null;
  }

  public toString(): string {
    return dedent`
      Submit Hash Response
        Previous Block Data: ${this._previousBlockData ? HexConverter.encode(this._previousBlockData) : null}
        ${this.txProof.toString()}`;
  }
}
