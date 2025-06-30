import type { UpdateNonFungibleTokenTransactionOrder } from '@unicitynetwork/bft-js-sdk/lib/tokens/transactions/UpdateNonFungibleToken.js';
import { TransactionRecordWithProof } from '@unicitynetwork/bft-js-sdk/lib/transaction/record/TransactionRecordWithProof.js';
import { dedent } from '@unicitynetwork/bft-js-sdk/lib/util/StringUtils.js';
import { HexConverter } from '@unicitylabs/commons/lib/util/HexConverter.js';

export class SubmitHashResponse {
  public constructor(
    private readonly _previousBlockHash: Uint8Array | null,
    public readonly txProof: TransactionRecordWithProof<UpdateNonFungibleTokenTransactionOrder>,
  ) {
    this._previousBlockHash = _previousBlockHash ? new Uint8Array(_previousBlockHash) : null;
  }

  public get previousBlockHash(): Uint8Array | null {
    return this._previousBlockHash ? new Uint8Array(this._previousBlockHash) : null;
  }

  public toString(): string {
    return dedent`
      Submit Hash Response
        Previous Block Hash: ${this._previousBlockHash ? HexConverter.encode(this._previousBlockHash) : null}
        ${this.txProof.toString()}`;
  }
}
